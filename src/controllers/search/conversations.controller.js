import mongoose from "mongoose";
import { AppError } from "../../middleware/errorHandler.js";
import SearchConversation from "../../models/SearchConversation.model.js";

// Persisted search conversations + the active shopping task — Phase 1 of
// the frontend repo's docs/velte-ai-search-flow-plan.md. Called only by the
// velte frontend (its /api/search route server-side, and its BFF
// conversation route for the client-resolved turns the route never sees) —
// never directly by a buyer's browser. Ownership is the deviceId: an
// unguessable per-browser UUID, required on every call and matched against
// the stored document, same trust model the public pay-link ids use.

// A conversation idle longer than this is finished, not resumable — ensure
// starts a fresh one instead of appending a new need onto a day-old thread
// (whose task/history would mislead the model), and GET refuses to
// rehydrate it (the frontend clears its stored id and starts clean).
const STALE_MS = 24 * 60 * 60 * 1000;

// Hard cap on stored turns per conversation ($slice) — a bounded document,
// not an unbounded chat log. Oldest turns fall off first; 30 exchanges is
// far beyond any real shopping session.
const MAX_TURNS = 30;

// How many of the most recent turns feed the model-facing text history —
// enough for real refinement chains, small enough to never crowd the
// prompt.
const HISTORY_TURNS = 12;

function isStale(conversation) {
  return Date.now() - conversation.lastActiveAt.getTime() > STALE_MS;
}

// Mirrors SearchHome.tsx's own history-building exactly (its
// runSearchIntoTurn): user text falls back to "[sent a photo]" for a bare
// photo turn, the assistant side carries the reply plus the machine-only
// contextNote breadcrumb, and the two buyer-request flags ride along so the
// agreement short-circuit still works across a refresh.
function buildHistory(conversation) {
  return conversation.turns.slice(-HISTORY_TURNS).flatMap((turn) => [
    { role: "user", content: turn.query || "[sent a photo]" },
    {
      role: "assistant",
      content: turn.contextNote
        ? `${turn.reply}\n${turn.contextNote}`
        : turn.reply,
      awaitingBuyerRequestReply: turn.awaitingBuyerRequestReply,
      buyerRequestMatchQuery: turn.buyerRequestMatchQuery,
    },
  ]);
}

// The active shopping task, derived from the turn that just landed — the
// single writer for task state (clients never set it). `goal` carries the
// caller's read of the request itself (item, budget, attributes, whether
// this turn started a NEW request) — see the model's own goal-sheet
// comment. Everything here accumulates ACROSS a request and resets when a
// new one begins, which is what stops one request's ceiling narrowing the
// next one's search.
function deriveTask(snapshot, prevTask, goal = {}) {
  const productCount =
    (Array.isArray(snapshot.products) ? snapshot.products.length : 0) +
    (Array.isArray(snapshot.vendorProducts)
      ? snapshot.vendorProducts.length
      : 0);
  const storeCount = Array.isArray(snapshot.stores)
    ? snapshot.stores.length
    : 0;

  let status;
  if (snapshot.clarification) {
    // Still asking — the request isn't fully formed yet.
    status = "gathering";
  } else if (productCount > 0 || storeCount > 0) {
    status = "presented";
  } else if (
    snapshot.buyerRequestOffered ||
    snapshot.buyerRequestOffer ||
    snapshot.toolCalled
  ) {
    // A real search ran (or a reach-out offer was made) and nothing on
    // Velte came back — this is the demand signal.
    status = "dead_end";
  } else {
    // A plain non-search reply (off-topic decline, acknowledgement) — the
    // task is whatever it already was.
    status = prevTask?.status ?? "gathering";
  }

  // A new request wipes the sheet; anything else builds on it. The caller
  // decides which (it owns the classifier + the item-match lock), so this
  // stays a pure writer.
  const carried = goal.startsFreshRequest ? null : prevTask;

  // Everything already shown for THIS request, plus whatever this turn put
  // on screen — deduped and capped so a long session can't grow the
  // document without bound.
  const shownProductIds = Array.from(
    new Set([
      ...(carried?.shownProductIds ?? []),
      ...(Array.isArray(snapshot.products)
        ? snapshot.products.map((p) => p?.productId).filter(Boolean)
        : []),
    ]),
  ).slice(-40);

  // Real, comparable prices only: a quote-on-request listing stores 0 as a
  // placeholder, and treating that as "cheapest seen" would make every
  // later "find something cheaper" impossible to satisfy.
  const pricesThisTurn = (
    Array.isArray(snapshot.products) ? snapshot.products : []
  )
    .filter((p) => p && !p.quoteOnRequest && typeof p.price === "number" && p.price > 0)
    .map((p) => p.price);
  const cheapestCandidates = [
    ...(carried?.cheapestSeenNaira != null ? [carried.cheapestSeenNaira] : []),
    ...pricesThisTurn,
  ];

  return {
    status,
    query: snapshot.query || carried?.query || "",
    storesQuery: snapshot.storesQuery ?? null,
    productCount,
    storeCount,
    itemTerm: goal.itemTerm ?? carried?.itemTerm ?? null,
    // A budget named on THIS turn always wins; otherwise the request keeps
    // whatever ceiling it already had.
    maxBudgetNaira:
      typeof goal.maxBudgetNaira === "number"
        ? goal.maxBudgetNaira
        : (carried?.maxBudgetNaira ?? null),
    attributes: Array.isArray(goal.attributes) && goal.attributes.length
      ? Array.from(
          new Set([...(carried?.attributes ?? []), ...goal.attributes]),
        ).slice(0, 12)
      : (carried?.attributes ?? []),
    shownProductIds,
    cheapestSeenNaira: cheapestCandidates.length
      ? Math.min(...cheapestCandidates)
      : null,
    updatedAt: new Date(),
  };
}

// Merges an incoming location update into what's already stored (Phase 5 —
// see the model's own buyerLocation comment). Deliberately additive: a turn
// that carries no location must never erase one already settled (the
// frontend simply omits the field on turns where nothing changed), and a
// known coordinate is never overwritten by a bare decline — a buyer who
// shared their location and later declines a re-ask still HAS a usable
// position. Returns the value to store, or the existing one untouched.
function mergeBuyerLocation(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return existing;
  const hasCoords =
    typeof incoming.lat === "number" && typeof incoming.lng === "number";
  const declined = Boolean(incoming.declined);
  if (!hasCoords && !declined && !incoming.placeName) return existing;

  return {
    lat: hasCoords ? incoming.lat : (existing?.lat ?? null),
    lng: hasCoords ? incoming.lng : (existing?.lng ?? null),
    placeName:
      typeof incoming.placeName === "string" && incoming.placeName.trim()
        ? incoming.placeName.trim().slice(0, 200)
        : (existing?.placeName ?? null),
    declined: declined || Boolean(existing?.declined),
    updatedAt: new Date(),
  };
}

function serializeBuyerLocation(stored) {
  if (!stored) return null;
  return {
    lat: stored.lat ?? null,
    lng: stored.lng ?? null,
    placeName: stored.placeName ?? null,
    declined: Boolean(stored.declined),
  };
}

function requireDeviceId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new AppError("deviceId is required.", 400);
  }
  return value.trim();
}

// ── POST /api/search/conversations/ensure ─────────────────────────────────
// Load-or-create, called by the frontend's /api/search route at the start
// of every turn: returns the conversation to append into plus the
// model-facing text history rebuilt from its stored turns. A missing,
// foreign (deviceId mismatch), or stale conversationId is never an error —
// a fresh conversation is created instead, and the frontend just adopts
// the new id from the turn's final event.
export async function ensureConversation(req, res, next) {
  try {
    const deviceId = requireDeviceId(req.body?.deviceId);
    const { conversationId, buyerId, buyerLocation } = req.body ?? {};

    if (
      typeof conversationId === "string" &&
      mongoose.isValidObjectId(conversationId)
    ) {
      const existing = await SearchConversation.findOne({
        _id: conversationId,
        deviceId,
      });
      if (existing && !isStale(existing)) {
        // Stamp the buyer id opportunistically — a buyer who verified via
        // OTP mid-conversation ties their earlier anonymous turns to the
        // account from here on. Location merges the same way (see
        // mergeBuyerLocation) so a position resolved mid-session is stored
        // as soon as it's known, not only at the end of the turn.
        let dirty = false;
        if (typeof buyerId === "string" && buyerId && !existing.buyerId) {
          existing.buyerId = buyerId;
          dirty = true;
        }
        const mergedLocation = mergeBuyerLocation(
          existing.buyerLocation,
          buyerLocation,
        );
        if (mergedLocation !== existing.buyerLocation) {
          existing.buyerLocation = mergedLocation;
          dirty = true;
        }
        if (dirty) await existing.save();

        return res.json({
          success: true,
          data: {
            conversationId: existing._id.toString(),
            isNew: false,
            history: buildHistory(existing),
            recentStatuses: existing.recentStatuses ?? [],
            buyerLocation: serializeBuyerLocation(existing.buyerLocation),
            // The goal sheet as it stands BEFORE this turn — the caller
            // applies its own two locks before using any of it.
            task: existing.task ?? null,
          },
        });
      }
    }

    const created = await SearchConversation.create({
      deviceId,
      buyerId: typeof buyerId === "string" && buyerId ? buyerId : null,
      buyerLocation: mergeBuyerLocation(null, buyerLocation),
    });
    res.json({
      success: true,
      data: {
        conversationId: created._id.toString(),
        isNew: true,
        history: [],
        recentStatuses: [],
        buyerLocation: serializeBuyerLocation(created.buyerLocation),
        task: null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/conversations/:id/turns ──────────────────────────────
// Append one completed exchange (a StoredSearchTurn snapshot — see the
// frontend's src/types/search.ts). Two callers conform to the same shape:
// the frontend's /api/search route right after emitting a turn's final
// event, and its BFF conversation route for client-resolved turns
// (background items). Also the single place task state advances.
export async function appendTurn(req, res, next) {
  try {
    const deviceId = requireDeviceId(req.body?.deviceId);
    const { id } = req.params;
    const { turn, buyerId, recentStatuses, buyerLocation, goal } =
      req.body ?? {};

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }
    if (!turn || typeof turn !== "object" || typeof turn.reply !== "string") {
      throw new AppError("A turn snapshot is required.", 400);
    }

    const conversation = await SearchConversation.findOne({
      _id: id,
      deviceId,
    });
    if (!conversation) {
      throw new AppError("Conversation not found.", 404);
    }

    conversation.turns.push({
      query: typeof turn.query === "string" ? turn.query : "",
      reply: turn.reply,
      contextNote: typeof turn.contextNote === "string" ? turn.contextNote : null,
      awaitingBuyerRequestReply: Boolean(turn.awaitingBuyerRequestReply),
      buyerRequestMatchQuery:
        typeof turn.buyerRequestMatchQuery === "string"
          ? turn.buyerRequestMatchQuery
          : null,
      snapshot: turn,
      createdAt: new Date(),
    });
    if (conversation.turns.length > MAX_TURNS) {
      conversation.turns = conversation.turns.slice(-MAX_TURNS);
    }
    conversation.task = deriveTask(turn, conversation.task, goal ?? {});
    // Replaced wholesale — the frontend's copy is already the merged,
    // capped, most-recent-last list (route.ts seeds it from here plus its
    // own turn's pushes). Bounded defensively regardless of what arrives.
    if (Array.isArray(recentStatuses)) {
      conversation.recentStatuses = recentStatuses
        .filter((s) => typeof s === "string" && s.length <= 300)
        .slice(-8);
    }
    conversation.buyerLocation = mergeBuyerLocation(
      conversation.buyerLocation,
      buyerLocation,
    );
    conversation.lastActiveAt = new Date();
    if (typeof buyerId === "string" && buyerId && !conversation.buyerId) {
      conversation.buyerId = buyerId;
    }
    await conversation.save();

    res.json({ success: true, data: { conversationId: id } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/search/conversations/:id?deviceId= ───────────────────────────
// Full snapshots for the frontend's refresh rehydrate. A stale
// conversation 404s on purpose — the frontend clears its stored id and the
// next search starts a fresh one.
export async function getConversation(req, res, next) {
  try {
    const deviceId = requireDeviceId(req.query?.deviceId);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }
    const conversation = await SearchConversation.findOne({
      _id: id,
      deviceId,
    });
    if (!conversation || isStale(conversation)) {
      throw new AppError("Conversation not found.", 404);
    }

    res.json({
      success: true,
      data: {
        conversationId: conversation._id.toString(),
        turns: conversation.turns.map((t) => t.snapshot),
        task: conversation.task ?? null,
        recentStatuses: conversation.recentStatuses ?? [],
        buyerLocation: serializeBuyerLocation(conversation.buyerLocation),
        lastActiveAt: conversation.lastActiveAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/conversations/:id/handoff ────────────────────────────
// The shopping task's terminal transition: the buyer clicked a WhatsApp
// chat CTA on a search result — fired as a best-effort beacon from the
// frontend's reportLead alongside the lead-billing beacon, so it must
// never error loudly. Only flips an EXISTING task (a handoff with no task
// recorded means the conversation predates task tracking — nothing to
// invent after the fact).
export async function markHandoff(req, res, next) {
  try {
    const deviceId = requireDeviceId(req.body?.deviceId);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }
    const conversation = await SearchConversation.findOne({
      _id: id,
      deviceId,
    });
    if (!conversation) {
      throw new AppError("Conversation not found.", 404);
    }
    if (conversation.task) {
      conversation.task.status = "handed_off";
      conversation.task.updatedAt = new Date();
      conversation.lastActiveAt = new Date();
      await conversation.save();
    }
    res.json({ success: true, data: { conversationId: id } });
  } catch (err) {
    next(err);
  }
}
