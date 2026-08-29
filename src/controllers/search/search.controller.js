import {
  searchProducts as findProducts,
  searchStores as findStores,
} from "../../services/retrieval.service.js";
import { AppError } from "../../middleware/errorHandler.js";
import RecruitmentLead from "../../models/RecruitmentLead.model.js";

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

export async function logSearch(req, res, next) {
  try {
    const { rawQuery, parsedProduct, externalStoreSuggestions } = req.body ?? {};

    if (!Array.isArray(externalStoreSuggestions) || !externalStoreSuggestions.length) {
      res.json({ success: true });
      return;
    }

    const matchedQuery =
      (typeof parsedProduct === "string" && parsedProduct) ||
      (typeof rawQuery === "string" ? rawQuery : null);

    await Promise.all(
      externalStoreSuggestions.map((s) => {
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
            ...(matchedQuery
              ? { $push: { matchedQueries: { $each: [matchedQuery], $slice: -20 } } }
              : {}),
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
