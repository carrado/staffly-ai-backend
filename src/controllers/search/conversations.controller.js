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

// How long before a conversation's SHOPPING TASK is treated as finished.
//
// Reworded 2026-08-26 along with what it does. It used to mean the whole
// conversation was finished: ensure abandoned a stale thread and started a
// fresh one. That stopped being right once buyers could pick an old thread
// out of their history and type into it — see ensureConversation for the
// full reasoning. Now the thread always survives and only the task (the
// goal sheet: budget, item term, products already shown) is cleared, since
// that is the part that actually misleads a search made a day later.
//
// GET still refuses to rehydrate a stale thread on the mount-time path —
// coming back tomorrow starts clean — unless the caller explicitly asks for
// it with includeStale, which is what opening one from the history list
// does.
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
      awaitingComparisonPurchaseReply: turn.awaitingComparisonPurchaseReply,
      comparisonPickItem: turn.comparisonPickItem,
      comparisonOptions:
        Array.isArray(turn.comparisonOptions) && turn.comparisonOptions.length
          ? turn.comparisonOptions
          : null,
      awaitingVendorSearchOffer: turn.awaitingVendorSearchOffer,
      vendorSearchMatchQuery: turn.vendorSearchMatchQuery,
      isGuidanceReply: turn.isGuidanceReply,
      awaitingShoppingPlanReply: turn.awaitingShoppingPlanReply,
      askedLocation: turn.askedLocation,
      askedBudget: turn.askedBudget,
      askedShoppingListDetails: turn.askedShoppingListDetails,
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

// The signed-in buyer (or vendor), when the caller had one. Never required
// and never trusted from a browser: the frontend reads it from its own
// verified session before calling this service (buyer_auth_token via
// buyerGuards.ts, auth_token via guards.ts), exactly as it already does for
// ensure/append — this service is only ever reachable server-side.
function optionalId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    return null;
  }
  return value.trim();
}
const optionalBuyerId = optionalId;
const optionalVendorId = optionalId;

function requireBuyerId(value) {
  const buyerId = optionalBuyerId(value);
  if (!buyerId) throw new AppError("buyerId is required.", 400);
  return buyerId;
}

// Either identity works — a vendor's own history list/delete is exactly as
// valid an owner as a buyer's (2026-09-17). The frontend only ever sends one
// of the two (buyer wins whenever both cookies exist — see its /api/search
// route's own actorType comment), so this never has to arbitrate between
// them, only refuse a caller with neither.
function requireOwnerId(buyerId, vendorId) {
  const buyer = optionalBuyerId(buyerId);
  if (buyer) return { buyerId: buyer, vendorId: null };
  const vendor = optionalVendorId(vendorId);
  if (vendor) return { buyerId: null, vendorId: vendor };
  throw new AppError("buyerId or vendorId is required.", 400);
}

// Ownership, widened for accounts (2026-08-26, widened again 2026-09-17 for
// vendorId). The deviceId is still the anonymous owner and still the only
// one an unauthenticated buyer has — but a signed-in buyer (or vendor) must
// be able to open their own conversation from a DIFFERENT browser than the
// one that created it, which is the entire point of having an account.
// Matching the device that made it, the buyer it belongs to, or the vendor
// it belongs to is what makes the history real rather than per-device.
//
// Note this can only ever WIDEN access to a conversation the caller already
// proves a claim on: buyerId/vendorId arrive from a verified session, and a
// conversation only carries one once a verified buyer or vendor was present
// on it.
function ownershipFilter(deviceId, buyerId, vendorId) {
  const or = [{ deviceId }];
  if (buyerId) or.push({ buyerId });
  if (vendorId) or.push({ vendorId });
  return or.length > 1 ? { $or: or } : { deviceId };
}

// The list's title for one conversation: the buyer's own first message,
// which is what they'd recognise it by. Mirrors buildHistory's own
// convention for a bare photo turn rather than inventing a second one.
function conversationTitle(conversation) {
  const first = conversation.turns?.[0];
  if (!first) return "New search";
  const query = (first.query || "").trim();
  if (!query) return "[sent a photo]";
  return query.length > 80 ? `${query.slice(0, 79).trimEnd()}…` : query;
}

// ── POST /api/search/conversations/ensure ─────────────────────────────────
// Load-or-create, called by the frontend's /api/search route at the start
// of every turn: returns the conversation to append into plus the
// model-facing text history rebuilt from its stored turns. A missing or
// foreign conversationId (owned by neither this device nor this buyer) is
// never an error — a fresh conversation is created instead, and the
// frontend just adopts the new id from the turn's final event.
//
// A STALE one is no longer replaced, only reset: see the block below.
export async function ensureConversation(req, res, next) {
  try {
    const deviceId = requireDeviceId(req.body?.deviceId);
    const { conversationId, buyerId, vendorId, buyerLocation } = req.body ?? {};

    if (
      typeof conversationId === "string" &&
      mongoose.isValidObjectId(conversationId)
    ) {
      const existing = await SearchConversation.findOne({
        _id: conversationId,
        ...ownershipFilter(
          deviceId,
          optionalBuyerId(buyerId),
          optionalVendorId(vendorId),
        ),
      });
      if (existing) {
        // ── Stale means the GOAL SHEET is dead, not the thread ───────────
        //
        // Until 2026-08-26 a stale conversation was abandoned here and a
        // fresh one created in its place. That was right when the only way
        // back into a thread was "the tab you left open", and it is wrong
        // now that a buyer can deliberately pick a week-old conversation
        // out of their history: they would type into the thread on screen
        // and the reply would land in a different one, leaving the visible
        // conversation frozen and the new turn apparently lost.
        //
        // What staleness actually protects against is narrower than
        // dropping the thread — it's the TASK: a day-old ₦700k ceiling, a
        // remembered item term, a shownProductIds list, all silently
        // narrowing a search the buyer means freshly. So that is what gets
        // cleared, and only that. The transcript survives, because the
        // buyer is looking at it and a follow-up like "do you have it in
        // red?" means the item in front of them.
        //
        // The history the model sees survives too, deliberately: route.ts's
        // own requestRelation classifier already decides per turn whether
        // earlier turns apply ("new" drops them outright), so a second,
        // blunter time-based rule here would only fight it.
        const stale = isStale(existing);
        let dirty = false;
        if (stale && existing.task) {
          existing.task = null;
          dirty = true;
        }

        // Stamp the buyer/vendor id opportunistically — an account that
        // signs in mid-conversation ties their earlier anonymous turns to it
        // from here on. Location merges the same way (see
        // mergeBuyerLocation) so a position resolved mid-session is stored
        // as soon as it's known, not only at the end of the turn.
        if (typeof buyerId === "string" && buyerId && !existing.buyerId) {
          existing.buyerId = buyerId;
          dirty = true;
        }
        if (typeof vendorId === "string" && vendorId && !existing.vendorId) {
          existing.vendorId = vendorId;
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
        // Reviving a stale thread makes it current again — without this it
        // would still read as stale on the next turn, and getConversation
        // would keep refusing to rehydrate it after a refresh.
        if (stale) {
          existing.lastActiveAt = new Date();
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
            // The tool this conversation is still in the middle of, if any
            // — see the model's own comment. The caller falls back to this
            // whenever the message itself arrives without one, which is
            // every follow-up after the first.
            activeTool: existing.activeTool ?? null,
          },
        });
      }
    }

    const created = await SearchConversation.create({
      deviceId,
      buyerId: typeof buyerId === "string" && buyerId ? buyerId : null,
      vendorId: typeof vendorId === "string" && vendorId ? vendorId : null,
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
        // A brand new chat starts with no tool in play, by construction —
        // which is one of the two resets the product rule asks for.
        activeTool: null,
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
    const {
      turn,
      buyerId,
      vendorId,
      recentStatuses,
      buyerLocation,
      goal,
      activeTool,
    } = req.body ?? {};

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }
    if (!turn || typeof turn !== "object" || typeof turn.reply !== "string") {
      throw new AppError("A turn snapshot is required.", 400);
    }

    // Read-only — used to derive task/location/buyerId/vendorId below, never
    // saved from directly (see the atomic findOneAndUpdate further down, and
    // its own comment on why this used to be a read-modify-write race).
    const conversation = await SearchConversation.findOne({
      _id: id,
      ...ownershipFilter(
        deviceId,
        optionalBuyerId(buyerId),
        optionalVendorId(vendorId),
      ),
    });
    if (!conversation) {
      throw new AppError("Conversation not found.", 404);
    }

    const turnDoc = {
      query: typeof turn.query === "string" ? turn.query : "",
      reply: turn.reply,
      contextNote: typeof turn.contextNote === "string" ? turn.contextNote : null,
      awaitingBuyerRequestReply: Boolean(turn.awaitingBuyerRequestReply),
      buyerRequestMatchQuery:
        typeof turn.buyerRequestMatchQuery === "string"
          ? turn.buyerRequestMatchQuery
          : null,
      awaitingComparisonPurchaseReply: Boolean(
        turn.awaitingComparisonPurchaseReply,
      ),
      comparisonPickItem:
        typeof turn.comparisonPickItem === "string"
          ? turn.comparisonPickItem
          : null,
      comparisonOptions:
        Array.isArray(turn.comparisonOptions) &&
        turn.comparisonOptions.length > 0
          ? turn.comparisonOptions.filter((o) => typeof o === "string" && o)
          : undefined,
      awaitingVendorSearchOffer: Boolean(turn.awaitingVendorSearchOffer),
      vendorSearchMatchQuery:
        typeof turn.vendorSearchMatchQuery === "string"
          ? turn.vendorSearchMatchQuery
          : null,
      isGuidanceReply: Boolean(turn.isGuidanceReply),
      awaitingShoppingPlanReply: Boolean(turn.awaitingShoppingPlanReply),
      // Derived from the turn's own clarification rather than carried as a
      // separate field the frontend has to remember to set — see
      // types/search.ts's own comment on the bug this fixes.
      askedLocation: turn.clarification?.kind === "location",
      // Widened 2026-09-17: `skippable` alone used to be enough (every
      // bare-query gate turn unconditionally asked budget), but that gate
      // now skips budget on purpose for a bounded service whose price is
      // set by diagnosing the problem, not by what the buyer chooses to
      // spend (a mechanic, a repair — see the frontend's bareQueryGate.ts).
      // `budgetAsked` is that gate's own report of whether THIS specific
      // question actually asked about budget; both must be true, or a
      // non-budget bare-query ask would wrongly block a later, genuinely
      // budget-relevant ask within the same request (route.ts's own
      // alreadyAskedBudgetThisConversation).
      askedBudget:
        turn.clarification?.kind === "text" &&
        turn.clarification?.skippable === true &&
        turn.clarification?.budgetAsked === true,
      askedShoppingListDetails:
        turn.clarification?.kind === "text" &&
        turn.clarification?.listDetails === true,
      snapshot: turn,
      createdAt: new Date(),
    };

    // ── Atomic append (2026-09-09) ──────────────────────────────────────
    //
    // This used to be findOne → mutate the in-memory `turns` array/task/
    // location → save() — a read-modify-write. Two /api/search calls for
    // the SAME conversation close together (the client's own stream reader
    // dispatches the "final" event, and unlocks the composer for the next
    // message, as soon as it parses that line — well before this server
    // request's own persistence write and stream-close actually finish, so
    // a fast reply genuinely can start a second request while the first is
    // still saving) both read the same starting document, both pushed
    // their own turn onto their own in-memory copy, and whichever save()
    // landed second overwrote the first's turns array wholesale — the
    // earlier turn wasn't corrupted, it just silently never made it to
    // disk. Exactly the "there was a reply but it's gone after reload" bug
    // this was found from.
    //
    // `$push`/`$slice` apply atomically at the document level regardless of
    // concurrent writers — MongoDB serializes writes to one document, so
    // two concurrent pushes both land, in whichever order their writes are
    // applied, and the slice still correctly keeps only the last MAX_TURNS
    // afterward. task/recentStatuses/buyerLocation/buyerId are still
    // computed off the read above and can themselves lose a race between
    // two concurrent appends (the LAST $set wins, same as before) — a much
    // smaller failure than losing a whole reply, and one that self-corrects
    // as soon as the next turn lands, so it's left as is rather than
    // rebuilt around a retry loop for what the reported bug never actually
    // was.
    const newTask = deriveTask(turn, conversation.task, goal ?? {});
    const mergedLocation = mergeBuyerLocation(
      conversation.buyerLocation,
      buyerLocation,
    );
    const setFields = {
      task: newTask,
      buyerLocation: mergedLocation,
      lastActiveAt: new Date(),
    };
    if (Array.isArray(recentStatuses)) {
      setFields.recentStatuses = recentStatuses
        .filter((s) => typeof s === "string" && s.length <= 300)
        .slice(-8);
    }
    if (typeof buyerId === "string" && buyerId && !conversation.buyerId) {
      setFields.buyerId = buyerId;
    }
    if (typeof vendorId === "string" && vendorId && !conversation.vendorId) {
      setFields.vendorId = vendorId;
    }
    // The session's active tool, as the route decided it at the END of this
    // turn — see the model's own comment. The caller always sends an explicit
    // value (a string to keep, or null to drop it), so `undefined` means
    // "this caller doesn't participate" (the BFF's client-resolved background
    // turns) and leaves whatever is stored untouched.
    if (typeof activeTool === "string" && activeTool.length <= 40) {
      setFields.activeTool = activeTool;
    } else if (activeTool === null) {
      setFields.activeTool = null;
    }

    await SearchConversation.updateOne(
      {
        _id: id,
        ...ownershipFilter(
          deviceId,
          optionalBuyerId(buyerId),
          optionalVendorId(vendorId),
        ),
      },
      {
        $push: { turns: { $each: [turnDoc], $slice: -MAX_TURNS } },
        $set: setFields,
      },
    );

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
    const buyerId = optionalBuyerId(req.query?.buyerId);
    const vendorId = optionalVendorId(req.query?.vendorId);
    // Opening a thread deliberately picked from the history list, as
    // opposed to the mount-time rehydrate of whichever conversation this
    // browser was last in. The distinction matters because of staleness
    // below; default false keeps every existing caller's behaviour
    // byte-for-byte.
    const includeStale = req.query?.includeStale === "true";
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }
    const conversation = await SearchConversation.findOne({
      _id: id,
      ...ownershipFilter(deviceId, buyerId, vendorId),
    });
    // The staleness refusal exists for the REHYDRATE path: a day-old thread
    // resumed silently would carry its own task/goal sheet into a new need,
    // so the frontend is told 404, clears its stored id and starts clean.
    // That is exactly wrong for a history list, where old threads are the
    // whole point — hence the opt-in rather than dropping the rule.
    if (!conversation || (isStale(conversation) && !includeStale)) {
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
        // Internal only — the frontend's BFF route strips both before they
        // ever reach a browser. Lets that route refuse a buyer- or vendor-
        // owned conversation to a caller whose session has since ended
        // (expired, or cleared some way other than its own logout button,
        // which is the only client-side path that drops the local resume
        // id) — see that route's own comment on why deviceId alone isn't
        // enough once an account was ever attached.
        buyerId: conversation.buyerId ?? null,
        vendorId: conversation.vendorId ?? null,
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
    const buyerId = optionalBuyerId(req.body?.buyerId);
    const vendorId = optionalVendorId(req.body?.vendorId);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }
    const conversation = await SearchConversation.findOne({
      _id: id,
      ...ownershipFilter(deviceId, buyerId, vendorId),
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

// ── GET /api/search/conversations?buyerId=&vendorId=&limit=&before= ───────
// The chat-history list (2026-08-26, widened 2026-09-17 for a vendor's own
// history): every conversation belonging to a signed-in buyer OR vendor,
// newest first, for the sidebar they pick from. Opening one is still
// GET /conversations/:id — this only produces the row.
//
// Deliberately does NOT return turns. A stored turn carries the entire
// denormalised result set it rendered (products, stores, services, images —
// see the frontend's buildTurnSnapshot), so returning even a page of full
// conversations would be megabytes to draw a list of titles. The projection
// below pulls `turns.query` and nothing else: one short string per turn
// instead of the whole snapshot, which is enough for both the title and the
// count.
//
// Staleness is not applied here on purpose — a history that hides
// everything older than a day is not a history. See getConversation's own
// note on the two different jobs that rule does.
export async function listConversations(req, res, next) {
  try {
    const owner = requireOwnerId(req.query?.buyerId, req.query?.vendorId);

    const rawLimit = Number.parseInt(req.query?.limit ?? "", 10);
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;

    // Keyset pagination on the same field the sort uses, rather than skip:
    // an account scrolling their history while a new turn lands would
    // silently skip or repeat a row under an offset, and there is no cheap
    // fix for that with skip. `before` is the previous page's last
    // lastActiveAt.
    const filter = {
      ...(owner.buyerId ? { buyerId: owner.buyerId } : { vendorId: owner.vendorId }),
      // A conversation with no completed turn is one `ensure` created for a
      // turn that never finished — a real row in the database, but nothing
      // the account would recognise as a conversation.
      "turns.0": { $exists: true },
    };
    const before = req.query?.before ? new Date(req.query.before) : null;
    if (before && !Number.isNaN(before.getTime())) {
      filter.lastActiveAt = { $lt: before };
    }

    const conversations = await SearchConversation.find(filter)
      .select("turns.query task.status lastActiveAt createdAt")
      .sort({ lastActiveAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: {
        conversations: conversations.map((c) => ({
          conversationId: c._id.toString(),
          title: conversationTitle(c),
          turnCount: c.turns?.length ?? 0,
          status: c.task?.status ?? null,
          lastActiveAt: c.lastActiveAt.toISOString(),
          createdAt: c.createdAt ? c.createdAt.toISOString() : null,
        })),
        // Null when this page didn't fill, so the client knows to stop
        // rather than issuing one more request that returns nothing.
        nextBefore:
          conversations.length === limit
            ? conversations[conversations.length - 1].lastActiveAt.toISOString()
            : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/conversations/claim ──────────────────────────────────
// Called once, right after a buyer signs in: attaches every conversation
// this browser already had to the account.
//
// Why it's needed even though ensure/append already stamp buyerId: those
// stamp only the conversation being actively worked on, and only from that
// moment forward. A buyer who searched anonymously three times and THEN
// signed in would see an empty history and quite reasonably conclude the
// feature is broken — their threads exist, they just carry no buyerId yet.
//
// Only claims conversations that have no buyerId at all. One that already
// belongs to a different account is never reassigned: shared or handed-down
// devices are ordinary in this market, and silently moving someone else's
// conversation history into whoever signed in next would be the worst
// possible failure here.
export async function claimConversations(req, res, next) {
  try {
    const deviceId = requireDeviceId(req.body?.deviceId);
    const buyerId = requireBuyerId(req.body?.buyerId);

    const result = await SearchConversation.updateMany(
      { deviceId, $or: [{ buyerId: null }, { buyerId: { $exists: false } }] },
      { $set: { buyerId } },
    );

    res.json({
      success: true,
      data: { claimed: result.modifiedCount ?? 0 },
    });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/search/conversations/:id?buyerId=|vendorId= ───────────────
// Removes one row from the sidebar's history list, for good (2026-09-09,
// widened 2026-09-17 for vendorId).
//
// buyerId/vendorId-only ownership, not the wider ownershipFilter every other
// route here uses — deliberately: listConversations (what the sidebar is
// actually deleting FROM) already requires one of the two itself, so a
// conversation never reaches a "delete" click without one. Accepting
// deviceId-only ownership here would let an anonymous browser delete a
// thread it can't even see listed, for no real use case.
export async function deleteConversation(req, res, next) {
  try {
    const owner = requireOwnerId(req.query?.buyerId, req.query?.vendorId);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError("Invalid conversation id.", 400);
    }

    const result = await SearchConversation.deleteOne({
      _id: id,
      ...(owner.buyerId ? { buyerId: owner.buyerId } : { vendorId: owner.vendorId }),
    });
    if (result.deletedCount === 0) {
      throw new AppError("Conversation not found.", 404);
    }

    res.json({ success: true, data: { conversationId: id } });
  } catch (err) {
    next(err);
  }
}
