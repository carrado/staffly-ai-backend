import mongoose from "mongoose";

import {
  searchProducts as findProducts,
  searchStores as findStores,
} from "../../services/retrieval.service.js";
import { AppError } from "../../middleware/errorHandler.js";
import RecruitmentLead from "../../models/RecruitmentLead.model.js";
import Product from "../../models/Product.model.js";

// Migrated from velte-backend/src/controllers/search/search.controller.js —
// this repo owns searchProducts/searchStores/logSearch (the buyer-facing
// search hot path). `chargeLead` (POST /api/search/lead, wallet billing)
// deliberately stayed behind in velte-backend: the frontend's sendBeacon
// call already hits velte-backend directly for that, so no cross-service
// call was ever needed for lead billing — see this repo's README.

// ── POST /api/search/products ─────────────────────────────────────────────
// Public — called by the frontend's searchProducts tool, for a buyer naming a
// specific item. Never directly by a buyer's browser. All ranking/matching
// logic lives in retrieval.service.js; this is just the HTTP wrapper.

export async function searchProducts(req, res, next) {
  try {
    const {
      queryText,
      attributesText,
      lat,
      lng,
      radiusKm,
      limit,
      isImageQuery,
      imageUrl,
      maxBudgetNaira,
      includeNearbyBusinesses,
    } = req.body ?? {};

    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    const hasLat = typeof lat === "number";
    const hasLng = typeof lng === "number";
    if (hasLat !== hasLng) {
      throw new AppError(
        "lat and lng must be provided together, or both omitted for a nationwide search.",
        400,
      );
    }

    const { results, weakResults, matchTier, matchQuality, externalSuggestions } =
      await findProducts({
        queryText,
        // The buyer's stated qualities (2026-09-15, explicit request) — a
        // SOFT ranking boost only, applied after a listing already
        // qualifies as a real match on `queryText` alone. See
        // retrieval.service.js's searchProducts/rankCandidates for the
        // full reasoning: this used to be merged straight into queryText
        // itself, which let a rerank pass mark down a genuinely good match
        // whose own listing text just didn't happen to echo those words.
        attributesText:
          typeof attributesText === "string" && attributesText.trim()
            ? attributesText
            : undefined,
        lat: hasLat ? lat : undefined,
        lng: hasLng ? lng : undefined,
        radiusKm: typeof radiusKm === "number" ? radiusKm : undefined,
        limit: typeof limit === "number" ? limit : undefined,
        isImageQuery: Boolean(isImageQuery),
        imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
        // Product searches opt OUT of Google Places (2026-08-26) — see
        // searchProducts' own comment in retrieval.service.js. Only an
        // explicit `false` disables it, so an older client that never
        // sends the field keeps the previous behavior.
        includeNearbyBusinesses: includeNearbyBusinesses !== false,
      });

    // The buyer's stated budget as a HARD price filter (the frontend's
    // searchProducts tool extracts it structurally — see its schema). A
    // post-retrieval filter on purpose: retrieval.service's tier cascade
    // stays untouched, and a range-priced listing passes on its MINIMUM
    // price (a ₦150k–₦250k range fits a ₦200k budget — the low end is
    // negotiable reality here). Quote-on-request listings pass too: their
    // stored price is a placeholder 0, not a real number to compare, and
    // hiding a vendor who'd happily quote within budget helps nobody.
    // matchTier/matchQuality describe the SEARCH that ran and are left
    // as-is even when this narrows the list.
    const withinBudget = (r) =>
      r.quoteOnRequest || typeof r.price !== "number" || r.price <= maxBudgetNaira;
    const budgeted =
      typeof maxBudgetNaira === "number" && maxBudgetNaira > 0
        ? {
            results: results.filter(withinBudget),
            weakResults: weakResults.filter(withinBudget),
          }
        : { results, weakResults };

    res.json({
      success: true,
      data: {
        results: budgeted.results,
        weakResults: budgeted.weakResults,
        matchTier,
        matchQuality,
        externalSuggestions,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/stores ───────────────────────────────────────────────
// Public — called by the frontend's searchStores tool, for a buyer describing
// a kind of business/vendor/shop rather than a specific item.

export async function searchStores(req, res, next) {
  try {
    const { queryText, lat, lng, radiusKm, limit, includeNearbyBusinesses } =
      req.body ?? {};

    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    const hasLat = typeof lat === "number";
    const hasLng = typeof lng === "number";
    if (hasLat !== hasLng) {
      throw new AppError(
        "lat and lng must be provided together, or both omitted for a nationwide search.",
        400,
      );
    }

    const { results, furtherResults, matchTier, matchQuality, externalSuggestions } =
      await findStores({
        queryText,
        lat: hasLat ? lat : undefined,
        lng: hasLng ? lng : undefined,
        radiusKm: typeof radiusKm === "number" ? radiusKm : undefined,
        limit: typeof limit === "number" ? limit : undefined,
        // See searchProducts above — same opt-out, same default.
        includeNearbyBusinesses: includeNearbyBusinesses !== false,
      });

    res.json({
      success: true,
      data: { results, furtherResults, matchTier, matchQuality, externalSuggestions },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/log ──────────────────────────────────────────────────
// Public — called once per buyer turn from the frontend's /api/search route,
// after the full LLM turn resolves. Deliberately NOT a general demand log of
// every query — the one real reason to persist anything here: when Velte had
// no vendor for a request AND Google Places surfaced a real, unlisted
// business nearby — that's a recruitment opportunity. A turn with nothing to
// report writes nothing at all.

// Instagram leads dedupe on a synthetic id in the same `placeId` slot — see
// the model's own comment. Lower-cased: Instagram handles are
// case-insensitive, and Google returns whichever casing the page uses.
function instagramPlaceId(handle) {
  return `instagram:${handle.trim().toLowerCase()}`;
}

function matchedQueryPush(matchedQuery) {
  return matchedQuery
    ? { $push: { matchedQueries: { $each: [matchedQuery], $slice: -20 } } }
    : {};
}

export async function logSearch(req, res, next) {
  try {
    const {
      rawQuery,
      parsedProduct,
      externalStoreSuggestions,
      instagramLeads,
    } = req.body ?? {};

    const places = Array.isArray(externalStoreSuggestions)
      ? externalStoreSuggestions
      : [];
    const instagram = Array.isArray(instagramLeads) ? instagramLeads : [];
    if (!places.length && !instagram.length) {
      res.json({ success: true });
      return;
    }

    const matchedQuery =
      (typeof parsedProduct === "string" && parsedProduct) ||
      (typeof rawQuery === "string" ? rawQuery : null);

    // Instagram leads SURFACED this turn (velte frontend, 2026-09-16) — the
    // same "shown to a buyer" signal Places rows get (hitCount), so the
    // recruitment queue sees both tiers. A buyer actually tapping Message
    // is logged separately, and more strongly, by logInstagramReachOut.
    await Promise.all(
      instagram.map((lead) => {
        if (
          !lead ||
          typeof lead.handle !== "string" ||
          !lead.handle.trim() ||
          typeof lead.title !== "string"
        ) {
          return null;
        }
        return RecruitmentLead.findOneAndUpdate(
          { placeId: instagramPlaceId(lead.handle) },
          {
            $set: {
              source: "instagram",
              name: lead.title,
              instagramHandle: lead.handle.trim(),
              profileUrl: typeof lead.url === "string" ? lead.url : null,
              lastSeenAt: new Date(),
            },
            $inc: { hitCount: 1 },
            ...matchedQueryPush(matchedQuery),
          },
          { upsert: true },
        );
      }),
    );

    await Promise.all(
      places.map((s) => {
        if (
          !s ||
          typeof s.placeId !== "string" ||
          typeof s.name !== "string" ||
          typeof s.address !== "string" ||
          typeof s.lat !== "number" ||
          typeof s.lng !== "number"
        ) {
          return null;
        }
        return RecruitmentLead.findOneAndUpdate(
          { placeId: s.placeId },
          {
            $set: {
              name: s.name,
              address: s.address,
              location: { type: "Point", coordinates: [s.lng, s.lat] },
              lastSeenAt: new Date(),
            },
            $inc: { hitCount: 1 },
            ...matchedQueryPush(matchedQuery),
          },
          { upsert: true },
        );
      }),
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/log/instagram-reachout ───────────────────────────────
// Public — fired as a best-effort beacon from the frontend's Instagram lead
// card the moment a buyer taps "Message on Instagram" (velte frontend,
// 2026-09-16). This is the strongest recruitment signal in the collection:
// the buyer was just handed a Velte intro (with the join link) to paste into
// that business's DMs, so the business is about to hear about Velte from a
// real customer. Upserts the same row logSearch would have (the lead may
// never have been logged as surfaced — a rehydrated turn from before that
// shipped, or a lost beacon), and bumps `buyerReachOuts` rather than
// `hitCount`, so "shown N times" and "actually contacted N times" stay
// distinct. Never fails the buyer — the card has already opened the DM
// thread by the time this lands.
export async function logInstagramReachOut(req, res, next) {
  try {
    const { handle, url, title, need, location } = req.body ?? {};
    if (typeof handle !== "string" || !handle.trim()) {
      res.status(400).json({ success: false, message: "handle is required." });
      return;
    }
    const matchedQuery =
      typeof need === "string" && need.trim()
        ? typeof location === "string" && location.trim()
          ? `${need.trim()} in ${location.trim()}`
          : need.trim()
        : null;

    await RecruitmentLead.findOneAndUpdate(
      { placeId: instagramPlaceId(handle) },
      {
        $set: {
          source: "instagram",
          instagramHandle: handle.trim(),
          ...(typeof title === "string" && title.trim()
            ? { name: title.trim() }
            : {}),
          ...(typeof url === "string" && url ? { profileUrl: url } : {}),
          lastReachOutAt: new Date(),
          lastSeenAt: new Date(),
        },
        // `name` is required on insert; a reach-out for a lead never logged
        // as surfaced (and sent without a title) still needs SOMETHING.
        $setOnInsert: {
          ...(typeof title === "string" && title.trim()
            ? {}
            : { name: `@${handle.trim()}` }),
        },
        $inc: { buyerReachOuts: 1 },
        ...matchedQueryPush(matchedQuery),
      },
      { upsert: true },
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/search/products/verify ────────────────────────────────────
// Shopping Plan (2026-09-19, "old ones shouldn't go provided they're still
// available" fix) — a DIRECT existence/suspension check for products the
// caller already knows about, as opposed to `searchProducts` above's
// ranked-and-capped result list. shoppingPlan.job.js used to infer a known
// candidate was gone purely from it not reappearing in that cycle's fresh
// top-N search — but the search only ever returns a capped slice, so a
// still-available product that merely ranked outside this cycle's window
// looked identical to a genuinely suspended/deleted one. This answers the
// narrower, provable question instead: does the document still exist, and
// is it not suspended — the exact same condition `searchProducts`' own
// `$match: { isSuspended: { $ne: true } }` filters on, so "still available"
// here means precisely "would still be returned if searched for again",
// never a looser or stricter definition than that.
//
// Public, same trust level as `searchProducts` above (no session, called
// only by the frontend's internal shopping-plan route) — this reveals
// nothing beyond "does this id, which the caller already holds, still
// exist and isn't suspended".
const MAX_VERIFY_IDS = 50;

export async function verifyProducts(req, res, next) {
  try {
    const { productIds } = req.body ?? {};
    if (!Array.isArray(productIds) || !productIds.length) {
      return res.json({ success: true, data: { available: [] } });
    }

    const validIds = productIds
      .filter((id) => typeof id === "string" && mongoose.isValidObjectId(id))
      .slice(0, MAX_VERIFY_IDS);
    if (!validIds.length) {
      return res.json({ success: true, data: { available: [] } });
    }

    const found = await Product.find({
      _id: { $in: validIds },
      isSuspended: { $ne: true },
    })
      .select("_id")
      .lean();

    res.json({
      success: true,
      data: { available: found.map((p) => p._id.toString()) },
    });
  } catch (err) {
    next(err);
  }
}
