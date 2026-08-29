// Retrieval core (Velte_Connect_Technical_Implementation.md §6) — ranks
// buyer queries by semanticRelevance + proximity + vendorTrust.
// `placementBoost` is left out: monetization isn't switched on yet (§11's
// own sequencing note).
//
// Migrated here from velte-backend/src/services/retrieval.service.js so the
// buyer-facing search hot path (this file) doesn't share traffic/deploys
// with the vendor dashboard API. velte-backend keeps a much smaller
// embedding.service.js (just embedAndSaveProduct/embedAndSaveStore, called
// on product/store create/update) — this repo never writes a Product or
// Store, only reads them for ranking.
//
// Two deliberate differences from the original, both from the wallet-
// boundary decision documented in this repo's README:
//  1. filterWalletEligible below reads WalletRead (this repo's read-only
//     model) but NEVER creates a wallet — a vendor with no wallet row yet is
//     just treated as balanceKobo 0 (ineligible), rather than being
//     auto-provisioned here. velte-backend now provisions a vendor's wallet
//     proactively at store-creation time (store.controller.js's
//     getOrCreateStore) specifically so this is never actually reached for
//     a vendor whose listings could appear in search. Wallet creation stays
//     sole-owned by velte-backend — duplicating the starter-credit grant
//     into a second repo would reintroduce the exact concurrency risk that
//     was already fixed once there (see velte-backend's wallet.controller.js
//     history).
//  2. LEAD_COST_KOBO is read from process.env here instead of imported from
//     velte-backend's wallet.controller.js (impossible across repos) — MUST
//     be kept equal to velte-backend's own MIN_LEAD_COST_KOBO (the top
//     tier's own rate — pricing is tiered there now, see its own comment
//     below), or this eligibility filter and actual lead billing will
//     disagree. Set the same value in both repos' env.

import Product from "../models/Product.model.js";
import Store from "../models/Store.model.js";
import VendorRead from "../models/VendorRead.model.js";
import WalletRead from "../models/WalletRead.model.js";
import Notification from "../models/Notification.model.js";
import VendorExposure from "../models/VendorExposure.model.js";
import { embed, embedImage, rerank } from "./voyage.service.js";
import { reverseGeocodeState } from "./nominatim.service.js";
import { searchNearbyBusinesses } from "./googlePlaces.service.js";
import { notifyUser } from "./pushNotification.service.js";
import { sectorKeywordsForLabels } from "../utils/sectorKeywords.js";

const VECTOR_INDEX_NAME = "product_vector_index";
const STORE_VECTOR_INDEX_NAME = "store_vector_index";

// Per-lead pricing is tiered now in velte-backend (₦500–₦1,000 depending
// on the vendor's own wallet balance — see that repo's utils/leadPricing.js)
// — this env var mirrors only MIN_LEAD_COST_KOBO, the top (most expensive)
// tier's own rate, since that's the one flat number search-time
// eligibility filtering actually needs: a balance that clears it can
// always afford AT LEAST one more lead, whatever tier it lands in (every
// OTHER tier's own balance floor comfortably covers its own, cheaper
// rate). MUST match velte-backend's own MIN_LEAD_COST_KOBO exactly (see
// file header note above) — currently ₦1,000.
const LEAD_COST_KOBO = Number(process.env.LEAD_COST_KOBO) || 100_000;

const WEIGHTS = {
  semantic: 0.5,
  proximity: 0.3,
  trust: 0.2,
};

// Used when there's no location signal at all — device permission denied/
// unavailable AND the buyer named no place in their query. There's nothing
// to score proximity against, so that term is dropped entirely and
// semantic/trust are renormalized proportionally (0.5:0.2 becomes
// ~0.714:0.286) rather than inventing a new, uncalibrated ratio.
const NATIONWIDE_WEIGHTS = {
  semantic: WEIGHTS.semantic / (WEIGHTS.semantic + WEIGHTS.trust),
  trust: WEIGHTS.trust / (WEIGHTS.semantic + WEIGHTS.trust),
};

// Tier 2 ("nearby") radius, as a multiplier of the caller's own tight-radius
// (Tier 1) value rather than a fixed km number — so a tool call that
// widened Tier 1 gets a proportionally wider Tier 2 too.
const NEARBY_RADIUS_MULTIPLIER = 3;

// A state-wide fallback match has no radiusKm to bound distance by — this is
// the reference distance proximity is normalized against instead.
const STATE_PROXIMITY_REFERENCE_KM = 300;

// Same idea as STATE_PROXIMITY_REFERENCE_KM, but for the "also available
// further out" bonus bucket's own country-wide candidate pool (see
// attachFurther) — roughly Nigeria's own north-south/east-west span, so
// proximity still contributes to ranking within that pool instead of being
// dropped entirely the way the genuine final "nationwide" tier drops it.
const FURTHER_PROXIMITY_REFERENCE_KM = 1200;

// Minimum semantic score a candidate needs to count as a real match. Two
// separate constants: rerank scores (a calibrated relevance probability) and
// raw Atlas vectorSearchScore (cosine similarity rescaled to 0-1) are
// different distributions — see original file history for the live
// calibration notes behind these numbers.
const RERANK_FLOOR = 0.58;
const RAW_SCORE_FLOOR = 0.75;

// How far below the main relevance floor a candidate can still land and
// count as "not a close match, but worth mentioning" rather than "not what
// the buyer asked for at all."
const WEAK_MATCH_MARGIN = 0.05;

// Buyer-facing ask: show a handful of not-that-close alternatives, clearly
// labeled as such. Capped small on purpose.
const WEAK_MATCH_LIMIT = 5;

// Exposure-based rotation ("equal share of visibility").
// EXPOSURE_WINDOW_DAYS: how far back "recently shown" looks.
// EXPOSURE_DECAY: multiplier applied to a candidate's ranking weight PER
// recent showing within that window.
const EXPOSURE_WINDOW_DAYS = 3;
const EXPOSURE_DECAY = 0.85;

function todayDateBucket() {
  return new Date().toISOString().slice(0, 10);
}

function exposureWindowCutoff() {
  return new Date(Date.now() - EXPOSURE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function exposureKey(vendorId, categoryId) {
  return `${vendorId}|${categoryId ?? ""}`;
}

async function fetchRecentExposure(pairs) {
  if (!pairs.length) return new Map();
  const vendorIds = [...new Set(pairs.map((p) => String(p.vendorId)))];
  const rows = await VendorExposure.find({
    vendorId: { $in: vendorIds },
    dateBucket: { $gte: exposureWindowCutoff() },
  }).select("vendorId categoryId shownCount");

  const counts = new Map();
  for (const row of rows) {
    const key = exposureKey(row.vendorId, row.categoryId);
    counts.set(key, (counts.get(key) ?? 0) + row.shownCount);
  }
  return counts;
}

async function recordExposure(shown) {
  if (!shown.length) return;
  const dateBucket = todayDateBucket();
  try {
    await VendorExposure.bulkWrite(
      shown.map(({ vendorId, categoryId }) => ({
        updateOne: {
          filter: { vendorId, categoryId: categoryId ?? null, dateBucket },
          update: {
            $inc: { shownCount: 1 },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    console.error("[retrieval] recordExposure failed:", err.message);
  }
}

// Convenience wrapper for the 5 searchProducts return sites below — pulls
// vendorId/categoryId off the already-ranked candidate shape (pre-mapResult)
// and fires the write without making the caller await it. Only ever called
// from searchProducts (searchStores has no exposure tracking — see its own
// rankArgs, trackExposure defaults false), so `.product` is safe to hardcode.
function recordActiveExposure(active) {
  if (!active.length) return;
  recordExposure(
    active.map((c) => ({
      vendorId: c.vendor._id,
      categoryId: c.product.categoryId ?? null,
    })),
  );
}

// Store counterpart, added for searchStores' "also available further out"
// bucket only (see pickFurtherResults/computeFurtherCap below) — stores have
// no categoryId of their own, so every store exposure key collapses to
// "vendorId|" (per-vendor, not per-category), same convention finalize()
// already uses for products when categoryId happens to be null.
function recordActiveStoreExposure(active) {
  if (!active.length) return;
  recordExposure(
    active.map((c) => ({
      vendorId: c.vendor._id,
      categoryId: c.store.categoryId ?? null,
    })),
  );
}

// "Near you" vs "also available further out" sizing: the further bucket is
// a bonus, never the main event — 1 extra when near-you is thin (1-2
// results, where a single alternative doesn't crowd the page), 2 when
// near-you already has a healthy set (3+), and never more than 2 regardless
// of how large near-you gets.
function computeFurtherCap(nearCount) {
  if (nearCount <= 0) return 0;
  return nearCount > 2 ? 2 : 1;
}

// Picks the further-out bonus slots from a wider tier's own already-ranked,
// already-wallet-eligible candidate pool (see rankCandidates — wallet
// filtering already happened before this pool exists). When more candidates
// are competing for the 1-2 bonus slots than there is room for, apply the
// same recent-exposure decay idea rankCandidates' own rotation uses for
// products (see EXPOSURE_DECAY/fetchRecentExposure above) — a vendor who's
// been winning this bonus slot constantly shouldn't always win it again.
async function pickFurtherResults(pool, cap) {
  if (!pool.length || cap <= 0) return [];
  if (pool.length <= cap) return pool;

  const exposureCounts = await fetchRecentExposure(
    pool.map((c) => ({
      vendorId: c.vendor._id,
      categoryId: c.store.categoryId ?? null,
    })),
  );
  const weights = pool.map((c) => {
    const shownCount =
      exposureCounts.get(exposureKey(c.vendor._id, c.store.categoryId ?? null)) ?? 0;
    return c.score * EXPOSURE_DECAY ** shownCount;
  });
  return weightedSampleWithoutReplacement(pool, weights, cap);
}

function weightedSampleWithoutReplacement(items, weights, k) {
  const keyed = items.map((item, i) => ({
    item,
    key: Math.random() ** (1 / Math.max(weights[i], 1e-9)),
  }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, k).map((k) => k.item);
}

// Shared time budget for every Voyage call within ONE searchProducts or
// searchStores invocation — see voyage.service.js's fetchWithRetry.
const SEARCH_DEADLINE_MS = 22_000;

// Separate floor for store-level search — store embedding text is typically
// much sparser than product text.
const STORE_RERANK_FLOOR = 0.58;
const STORE_RAW_SCORE_FLOOR = 0.7;

// How much above the base relevance floor a candidate must score to count
// as a "direct" match rather than merely "similar" — applies to every
// product search, text or image (semanticScore already folds in visualScore
// only when one exists, so a plain-text query's semanticScore is just its
// rerank textScore, same space this margin was originally calibrated on).
const MATCH_QUALITY_MARGIN = 0.08;

// How much a product's own visual similarity counts versus its text-derived
// semantic score, for image-derived searches only.
const VISUAL_BLEND_WEIGHT = 0.65;

// Eligibility escape hatch for image-derived searches only.
const VISUAL_ELIGIBILITY_FLOOR = 0.82;

/** Cosine similarity between two equal-length embedding vectors. */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function productEmbeddingText(product) {
  const attrs = (product.attributes || [])
    .map((a) => `${a.name}: ${a.value}`)
    .join(", ");
  return [product.name, product.categoryId, attrs, product.description]
    .filter(Boolean)
    .join(". ");
}

function storeEmbeddingText(store) {
  // Folds in each sector's buyer-facing keyword list (sectorKeywords.js) —
  // this is the QUERY-TIME rerank text (rankCandidates recomputes it fresh
  // on every search, never uses the stored vector), so this alone already
  // improves matching for existing vendors without needing a re-embed. See
  // embedding.service.js's identical change in velte-backend for the
  // write-time ($vectorSearch candidate pool) half of this fix.
  return [
    store.name,
    (store.sectors || []).join(" "),
    sectorKeywordsForLabels(store.sectors),
    store.description,
  ]
    .filter(Boolean)
    .join(". ");
}

/** Great-circle distance in km between two [lng, lat] points. */
function haversineKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Places' free-text search has no facet for "long-term lease" vs. "shortlet"
// — a query like "apartment rental" matches both a real letting agency AND a
// shortlet/serviced-apartment business, since the latter's own Google listing
// often uses that exact wording too (found live: an Enugu buyer asking for
// "an apartment to rent" got back The Mastadon Apartments and BOX 55, both
// nightly-rate shortlets, not the long-term lease they meant). Biasing the
// request to Places' own "real_estate_agency" type steers away from the
// lodging/hotel-typed shortlet businesses without needing query-text tricks
// Text Search doesn't support. Only applied when the query is clearly about
// renting/leasing AND doesn't itself name a shortlet — a buyer who actually
// wants a shortlet should still get one.
const RENTAL_INTENT = /\b(rent|rental|renting|lease|leasing|letting)\b/i;
const SHORTLET_INTENT = /\b(shortlet|short.let|airbnb|nightly|per.night|per.day)\b/i;
function placesIncludedType(queryText) {
  if (SHORTLET_INTENT.test(queryText)) return undefined;
  if (RENTAL_INTENT.test(queryText)) return "real_estate_agency";
  return undefined;
}

/**
 * Shared Tier 5 for both searchProducts and searchStores once every real
 * Velte-vendor geo tier has come up empty (or been fully wallet-filtered
 * out): real nearby businesses via Google Places. Best-effort: null on any
 * failure or nothing within radius.
 *
 * `lat`/`lng` can genuinely be absent here (a buyer who declined device
 * location and named no place in their query) — found live: this used to
 * mean the caller never even reached this function (retrieval.service.js's
 * own `!hasLocation` branches returned straight to a dead end), and this
 * function itself would have filtered out every result anyway (the
 * haversine distance from an undefined coordinate is NaN, and NaN <=
 * radiusKm is always false). Neither is correct — Google Places (via a
 * country-qualified text query, no geographic bias — see
 * searchNearbyBusinesses' own comment) is still a real, useful fallback
 * with no buyer coordinate at all; there's just no meaningful "distance
 * from the buyer" to attach to each result, so that field is omitted
 * (`null`) instead of filtered on.
 */
async function googlePlacesFallback(queryText, lat, lng, radiusKm) {
  const hasCoords = typeof lat === "number" && typeof lng === "number";
  const places = await searchNearbyBusinesses({
    // This app operates in Nigeria only today — with no buyer coordinate
    // to bias toward, qualifying the text itself is what keeps results
    // Nigeria-relevant instead of Places' own global default. Only
    // appended when genuinely locationless; a real coordinate already
    // scopes the search geographically, so adding this on top would just
    // be noise there.
    queryText: hasCoords ? queryText : `${queryText} Nigeria`,
    lat,
    lng,
    radiusKm,
    includedType: placesIncludedType(queryText),
  });
  if (!places?.length) return null;

  if (!hasCoords) {
    return places.map((p) => ({
      placeId: p.placeId,
      name: p.name,
      address: p.address,
      lat: p.lat,
      lng: p.lng,
      distanceKm: null,
    }));
  }

  const externalSuggestions = places
    .map((p) => ({
      placeId: p.placeId,
      name: p.name,
      address: p.address,
      lat: p.lat,
      lng: p.lng,
      distanceKm: Math.round(haversineKm([lng, lat], [p.lng, p.lat]) * 10) / 10,
    }))
    .filter((p) => p.distanceKm <= radiusKm);

  return externalSuggestions.length ? externalSuggestions : null;
}

/**
 * Drops any candidate whose vendor can't cover one more lead. Unlike the
 * original velte-backend version, this NEVER creates a wallet — a vendor
 * with no wallet row yet is simply ineligible (balanceKobo treated as 0).
 * See this file's header note.
 */
async function filterWalletEligible(rankedCandidates) {
  if (!rankedCandidates.length) return rankedCandidates;

  const vendorIds = [...new Set(rankedCandidates.map((c) => String(c.vendor._id)))];
  const wallets = await WalletRead.find({ vendorId: { $in: vendorIds } }).select(
    "vendorId balanceKobo",
  );
  const balanceById = new Map(wallets.map((w) => [String(w.vendorId), w.balanceKobo]));

  return rankedCandidates.filter(
    (c) => (balanceById.get(String(c.vendor._id)) ?? 0) >= LEAD_COST_KOBO,
  );
}

function isExpiredProduct(product) {
  return Boolean(product.expirationDate) && product.expirationDate.getTime() < Date.now();
}

// A popular expired listing could otherwise get searched dozens of times a
// day and fire a notification on every single one — capped to once per
// vendor per product within the window.
const EXPIRED_MATCH_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort, fire-and-forget: tells a vendor a buyer just searched for
 * something that matched one of their listings, except the listing is
 * expired and so was held back from the buyer's results. Never awaited by
 * callers.
 */
async function notifyExpiredMatches(expiredCandidates, queryText) {
  await Promise.allSettled(
    expiredCandidates.map(async ({ product, vendor }) => {
      try {
        const tag = `expired-product-${product._id}`;
        const recent = await Notification.findOne({
          userId: vendor._id,
          tag,
          createdAt: { $gte: new Date(Date.now() - EXPIRED_MATCH_NOTIFY_COOLDOWN_MS) },
        }).select("_id");
        if (recent) return;

        await notifyUser(vendor._id, {
          type: "expired-product",
          title: "Buyers are searching for an expired listing",
          body: `"${product.name}" matched a buyer's search for "${queryText}" but is hidden from results because it's expired. Update its expiration date or remove it so it can be found again.`,
          url: `/${vendor._id}/products/${product._id}/edit`,
          tag,
        });
      } catch (err) {
        console.error(
          `[retrieval] expired-product notify failed for vendor ${vendor._id}, product ${product._id}:`,
          err.message,
        );
      }
    }),
  );
}

/**
 * Splits a tier's already-ranked candidates into active vs. expired.
 * Deliberately runs AFTER rerank/floor/wallet-eligibility — only a
 * candidate that already cleared the exact same bar a real result does gets
 * flagged here.
 */
function splitExpired(tierCandidates, queryText) {
  const expired = tierCandidates.filter((c) => isExpiredProduct(c.product));
  const active = tierCandidates.filter((c) => !isExpiredProduct(c.product));
  if (expired.length) {
    notifyExpiredMatches(expired, queryText).catch((err) =>
      console.error("[retrieval] notifyExpiredMatches failed:", err.message),
    );
  }
  return active;
}

/**
 * Shared core for both searchProducts and searchStores: join vendors, apply
 * a geo filter (different per tier), rerank/floor, and rank by
 * semantic + proximity + trust.
 */
async function rankCandidates({
  candidates,
  vendorById,
  entityKey,
  embeddingTextFn,
  queryText,
  lat,
  lng,
  geoFilter,
  proximityReferenceKm,
  rerankFloor,
  rawScoreFloor,
  limit,
  queryImageVector,
  weights = WEIGHTS,
  deadlineAt,
  trackExposure = false,
}) {
  const locationless = lat == null || lng == null;

  const withVendor = candidates
    .map((entity) => {
      const vendor = vendorById.get(String(entity.vendorId));
      if (!vendor) return null;
      if (locationless) {
        return { [entityKey]: entity, vendor, distanceKm: null };
      }
      if (!vendor.geo?.coordinates?.length) return null;
      const distanceKm = haversineKm([lng, lat], vendor.geo.coordinates);
      if (!geoFilter(vendor, distanceKm)) return null;
      return { [entityKey]: entity, vendor, distanceKm };
    })
    .filter(Boolean);
  if (!withVendor.length) {
    return { candidates: [], weakCandidates: [], relevanceFloor: null };
  }

  const rerankScores = await rerank(
    queryText,
    withVendor.map((c) => embeddingTextFn(c[entityKey])),
    deadlineAt,
  );
  const relevanceFloor = rerankScores ? rerankFloor : rawScoreFloor;
  const weakFloor = relevanceFloor - WEAK_MATCH_MARGIN;

  const scored = withVendor
    .map((c, i) => ({
      ...c,
      textScore: rerankScores ? rerankScores[i] : c[entityKey].score,
    }))
    .map((c) => {
      const imageEmbedding = c[entityKey].imageEmbedding;
      const visualScore =
        queryImageVector && imageEmbedding
          ? cosineSimilarity(queryImageVector, imageEmbedding)
          : null;
      return { ...c, visualScore };
    });

  const isEligible = (c) =>
    c.textScore >= relevanceFloor ||
    (c.visualScore != null && c.visualScore >= VISUAL_ELIGIBILITY_FLOOR);
  const isWeak = (c) => !isEligible(c) && c.textScore >= weakFloor;

  const finalize = async (pool, poolLimit, useRotation) => {
    const withScore = pool
      .map((c) => {
        const semanticScore =
          c.visualScore != null
            ? VISUAL_BLEND_WEIGHT * c.visualScore + (1 - VISUAL_BLEND_WEIGHT) * c.textScore
            : c.textScore;
        return { ...c, semanticScore };
      })
      .map((c) => {
        const trustComponent = (c.vendor.trustScore ?? 0) / 100;
        if (locationless) {
          const score = weights.semantic * c.semanticScore + weights.trust * trustComponent;
          return { ...c, score };
        }
        const proximityScore = Math.max(0, 1 - c.distanceKm / proximityReferenceKm);
        const score =
          weights.semantic * c.semanticScore +
          weights.proximity * proximityScore +
          weights.trust * trustComponent;
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);

    const eligible = await filterWalletEligible(withScore);

    if (!useRotation || eligible.length <= poolLimit) {
      return eligible.slice(0, poolLimit);
    }

    const exposureCounts = await fetchRecentExposure(
      eligible.map((c) => ({
        vendorId: c.vendor._id,
        categoryId: c[entityKey].categoryId ?? null,
      })),
    );
    const rotationWeights = eligible.map((c) => {
      const shownCount =
        exposureCounts.get(
          exposureKey(c.vendor._id, c[entityKey].categoryId ?? null),
        ) ?? 0;
      return c.score * EXPOSURE_DECAY ** shownCount;
    });
    const winners = weightedSampleWithoutReplacement(
      eligible,
      rotationWeights,
      poolLimit,
    );
    return winners.sort((a, b) => b.score - a.score);
  };

  const [eligibleFinal, weakFinal] = await Promise.all([
    finalize(scored.filter(isEligible), limit, trackExposure),
    finalize(scored.filter(isWeak), WEAK_MATCH_LIMIT, false),
  ]);

  return {
    candidates: eligibleFinal,
    weakCandidates: weakFinal,
    relevanceFloor,
  };
}

// Splits a tier's already-ranked candidates into "direct" vs. "similar" —
// applied to every product search so a buyer gets an honest "no exact match,
// but here's something similar" whether they searched by text or photo.
function applyMatchQuality(tierCandidates, relevanceFloor) {
  if (!tierCandidates.length) {
    return { candidates: tierCandidates, matchQuality: undefined };
  }
  const directFloor = relevanceFloor + MATCH_QUALITY_MARGIN;
  const direct = tierCandidates.filter((c) => c.semanticScore >= directFloor);
  return direct.length
    ? { candidates: direct, matchQuality: "direct" }
    : { candidates: tierCandidates, matchQuality: "similar" };
}

/**
 * Search products by meaning + proximity + trust. `lat`/`lng` are optional
 * — omit both for a "nationwide" search. Geo tiers cascade: local → nearby
 * → state → nationwide → Tier 5 (Google Places, only when a location IS
 * known and Tiers 1-4 are all empty).
 */
export async function searchProducts({
  queryText,
  lat,
  lng,
  radiusKm = 10,
  limit = 20,
  isImageQuery = false,
  imageUrl,
  // Google Places is a SERVICE-only fallback as of 2026-08-26 (the caller
  // decides — see the frontend's allowsNearbyBusinesses). A buyer asking
  // for an ITEM got a wall of shop addresses that had never been checked
  // for stock, price or even relevance, so product searches now opt out
  // and the Places request is skipped outright rather than made and
  // discarded — this is a paid API. Defaults to true so any caller that
  // doesn't know about the flag behaves exactly as before.
  includeNearbyBusinesses = true,
}) {
  const placesFallback = (...args) =>
    includeNearbyBusinesses ? googlePlacesFallback(...args) : null;

  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;

  const queryVectors = await embed([queryText], "query", deadlineAt);
  const queryVector = queryVectors?.[0];
  if (!queryVector) {
    throw new Error("Could not embed the search query (Voyage unavailable).");
  }

  const queryImageVector =
    isImageQuery && imageUrl
      ? await embedImage(imageUrl, "query", undefined, deadlineAt)
      : null;

  const candidates = await Product.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates: 150,
        limit: 50,
      },
    },
    {
      $project: {
        embedding: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
    // Same post-vector-search filter pattern as the vendor hiddenFromSearch
    // check below — a suspended listing (super admin panel) must not surface
    // via AI/WhatsApp search even if it ranks well.
    { $match: { isSuspended: { $ne: true } } },
  ]);
  if (!candidates.length) {
    return { results: [], matchTier: null, matchQuality: undefined, externalSuggestions: null };
  }

  const vendorIds = [...new Set(candidates.map((c) => String(c.vendorId)))];
  const [vendors, stores] = await Promise.all([
    VendorRead.find({
      _id: { $in: vendorIds },
      hiddenFromSearch: { $ne: true },
    }).select("geo trustScore area state name phone company avatar"),
    Store.find({ vendorId: { $in: vendorIds } }).select(
      "vendorId name whatsapp handle",
    ),
  ]);
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const storeByVendorId = new Map(stores.map((s) => [String(s.vendorId), s]));

  const mapResult = ({ product, vendor, distanceKm, score }) => {
    const store = storeByVendorId.get(String(vendor._id));
    return {
      productId: product._id,
      kind: product.kind === "service" ? "service" : "product",
      name: product.name,
      price: product.price / 100,
      priceMax: product.priceMax != null ? product.priceMax / 100 : null,
      quoteOnRequest: product.quoteOnRequest === true,
      currency: product.currency,
      mainImageUrl: product.mainImageUrl,
      thumbnailUrls: product.thumbnailUrls || [],
      videoUrl: product.videoUrl ?? null,
      storeHandle: store?.handle ?? null,
      description: product.description ?? null,
      attributes: (product.attributes || []).map((a) => ({
        name: a.name,
        value: a.value,
      })),
      vendorId: vendor._id,
      vendorName: store?.name || vendor.company?.name || vendor.name,
      area: vendor.area,
      state: vendor.state,
      whatsapp: store?.whatsapp || vendor.phone || null,
      distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
      score: Math.round(score * 1000) / 1000,
    };
  };

  const rankArgs = {
    candidates,
    vendorById,
    entityKey: "product",
    embeddingTextFn: productEmbeddingText,
    queryText,
    rerankFloor: RERANK_FLOOR,
    rawScoreFloor: RAW_SCORE_FLOOR,
    limit,
    queryImageVector,
    deadlineAt,
    trackExposure: true,
  };

  const hasLocation = typeof lat === "number" && typeof lng === "number";

  if (!hasLocation) {
    const {
      candidates: nationwide,
      weakCandidates: nationwideWeak,
      relevanceFloor,
    } = await rankCandidates({
      ...rankArgs,
      weights: NATIONWIDE_WEIGHTS,
    });
    if (!nationwide.length) {
      // Found live: this used to return straight to a dead end — no
      // Velte vendor anywhere AND no location signal at all used to mean
      // Google Places never even got a chance to run (see
      // googlePlacesFallback's own comment on why it's still useful with
      // no coordinate). Nationwide is the widest DB tier that exists, so
      // once even that's empty, Places is the last real thing left to try
      // before this is a genuine dead end.
      const externalSuggestions = await placesFallback(
        queryText,
        lat,
        lng,
        radiusKm,
      );
      return {
        results: [],
        weakResults: [],
        matchTier: null,
        matchQuality: undefined,
        externalSuggestions,
      };
    }
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      nationwide,
      relevanceFloor,
    );
    const active = splitExpired(tiered, queryText);
    if (!active.length) {
      // Same reasoning as the `!nationwide.length` branch above — every
      // nationwide candidate that existed turned out to be expired
      // inventory, so this is just as much a real dead end otherwise.
      const externalSuggestions = await placesFallback(
        queryText,
        lat,
        lng,
        radiusKm,
      );
      return {
        results: [],
        weakResults: [],
        matchTier: null,
        matchQuality: undefined,
        externalSuggestions,
      };
    }
    recordActiveExposure(active);
    return {
      results: active.map(mapResult),
      weakResults: splitExpired(nationwideWeak, queryText).map(mapResult),
      matchTier: "nationwide",
      matchQuality,
      externalSuggestions: null,
    };
  }

  const locatedArgs = { ...rankArgs, lat, lng };

  // Tier 1: tight radius.
  const {
    candidates: local,
    weakCandidates: localWeak,
    relevanceFloor: localFloor,
  } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= radiusKm,
    proximityReferenceKm: radiusKm,
  });
  if (local.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      local,
      localFloor,
    );
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      recordActiveExposure(active);
      return {
        results: active.map(mapResult),
        weakResults: splitExpired(localWeak, queryText).map(mapResult),
        matchTier: "local",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 2: "nearby" — wider than Tier 1 but still a local search.
  const nearbyRadiusKm = radiusKm * NEARBY_RADIUS_MULTIPLIER;
  const {
    candidates: nearby,
    weakCandidates: nearbyWeak,
    relevanceFloor: nearbyFloor,
  } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= nearbyRadiusKm,
    proximityReferenceKm: nearbyRadiusKm,
  });
  if (nearby.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      nearby,
      nearbyFloor,
    );
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      recordActiveExposure(active);
      return {
        results: active.map(mapResult),
        weakResults: splitExpired(nearbyWeak, queryText).map(mapResult),
        matchTier: "nearby",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 3: same state.
  const buyerState = await reverseGeocodeState(lat, lng);
  const {
    candidates: stateWide,
    weakCandidates: stateWideWeak,
    relevanceFloor: stateFloor,
  } = buyerState
    ? await rankCandidates({
        ...locatedArgs,
        geoFilter: (vendor) =>
          Boolean(vendor.state) &&
          vendor.state.toLowerCase() === buyerState.toLowerCase(),
        proximityReferenceKm: STATE_PROXIMITY_REFERENCE_KM,
      })
    : { candidates: [], weakCandidates: [], relevanceFloor: null };

  if (stateWide.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      stateWide,
      stateFloor,
    );
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      recordActiveExposure(active);
      return {
        results: active.map(mapResult),
        weakResults: splitExpired(stateWideWeak, queryText).map(mapResult),
        matchTier: "state",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 4: nationwide, state-agnostic.
  const {
    candidates: nationwide,
    weakCandidates: nationwideTier4Weak,
    relevanceFloor: nationwideFloor,
  } = await rankCandidates({ ...rankArgs, weights: NATIONWIDE_WEIGHTS });
  if (nationwide.length) {
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      nationwide,
      nationwideFloor,
    );
    const active = splitExpired(tiered, queryText);
    if (active.length) {
      recordActiveExposure(active);
      return {
        results: active.map(mapResult),
        weakResults: splitExpired(nationwideTier4Weak, queryText).map(mapResult),
        matchTier: "nationwide",
        matchQuality,
        externalSuggestions: null,
      };
    }
  }

  // Tier 5: no Velte vendor matched at all.
  const externalSuggestions = await placesFallback(queryText, lat, lng, radiusKm);
  return {
    results: [],
    weakResults: [],
    matchTier: null,
    matchQuality: undefined,
    externalSuggestions,
  };
}

/**
 * Search stores (vendors as a business) by meaning + proximity + trust — for
 * a buyer describing a *kind* of business/vendor/shop rather than a
 * specific item. Same tiering as searchProducts.
 */
export async function searchStores({
  queryText,
  lat,
  lng,
  radiusKm = 10,
  limit = 20,
  // Google Places is a SERVICE-only fallback as of 2026-08-26 (the caller
  // decides — see the frontend's allowsNearbyBusinesses). A buyer asking
  // for an ITEM got a wall of shop addresses that had never been checked
  // for stock, price or even relevance, so product searches now opt out
  // and the Places request is skipped outright rather than made and
  // discarded — this is a paid API. Defaults to true so any caller that
  // doesn't know about the flag behaves exactly as before.
  includeNearbyBusinesses = true,
}) {
  const placesFallback = (...args) =>
    includeNearbyBusinesses ? googlePlacesFallback(...args) : null;

  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;

  const queryVectors = await embed([queryText], "query", deadlineAt);
  const queryVector = queryVectors?.[0];
  if (!queryVector) {
    throw new Error("Could not embed the search query (Voyage unavailable).");
  }

  const candidates = await Store.aggregate([
    {
      $vectorSearch: {
        index: STORE_VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates: 150,
        limit: 50,
      },
    },
    {
      $project: {
        embedding: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]);
  if (!candidates.length) {
    return { results: [], matchTier: null, matchQuality: undefined, externalSuggestions: null, furtherResults: [] };
  }

  const vendorIds = [...new Set(candidates.map((c) => String(c.vendorId)))];
  const vendors = await VendorRead.find({
    _id: { $in: vendorIds },
    hiddenFromSearch: { $ne: true },
  }).select("geo trustScore area state phone avatar");
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

  // avatar comes off the vendor's own user doc (VendorRead — see that
  // model's own comment), gallery off the Store doc itself (kept in the
  // aggregation output by the $project above, which only strips
  // `embedding`) — same two sources the marketplace's VendorCard already
  // reads (getVendorsPreview/getVendorsBrowse in velte-backend), so a
  // search result vendor card can render the identical avatar + sliding
  // cover instead of always falling back to placeholders.
  const mapResult = ({ store, vendor, distanceKm, score }) => ({
    storeId: store._id,
    vendorId: vendor._id,
    handle: store.handle,
    name: store.name,
    description: store.description,
    sectors: store.sectors,
    whatsapp: store.whatsapp || vendor.phone || null,
    area: vendor.area,
    state: vendor.state,
    distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
    score: Math.round(score * 1000) / 1000,
    avatar: vendor.avatar ?? null,
    gallery: store.gallery ?? [],
  });

  const rankArgs = {
    candidates,
    vendorById,
    entityKey: "store",
    embeddingTextFn: storeEmbeddingText,
    queryText,
    rerankFloor: STORE_RERANK_FLOOR,
    rawScoreFloor: STORE_RAW_SCORE_FLOOR,
    limit,
    deadlineAt,
  };

  const hasLocation = typeof lat === "number" && typeof lng === "number";

  // Accumulates each tier's "weak" (near-miss) candidates, in cascade
  // priority order, so that if NO tier anywhere finds a genuine match, the
  // CLOSEST tier's near-miss candidates can still be shown as a last resort
  // before falling all the way to Google Places — found live: a vendor whose
  // sectors named exactly what the buyer wanted ("Ushering Services") scored
  // just under the eligibility floor in every tier (their own store bio
  // never mentioned it, only the sectors tag did) and was silently dropped
  // straight to generic external suggestions, even though the closest real
  // Velte vendor for the request existed. applyMatchQuality is generic (not
  // product-specific) — reused here so a near-floor store result is honestly
  // tagged "similar", same distinction searchProducts already makes.
  const weakByTier = [];
  const tryTier = (tierCandidates, weakCandidates, tierFloor, matchTier) => {
    if (weakCandidates.length) weakByTier.push({ matchTier, weakCandidates });
    if (!tierCandidates.length) return null;
    const { candidates: tiered, matchQuality } = applyMatchQuality(
      tierCandidates,
      tierFloor,
    );
    return { results: tiered.map(mapResult), matchTier, matchQuality };
  };

  // Attaches the "also available further out" bonus bucket once a tier has
  // already answered — ALWAYS sourced from the nationwide pool, never just
  // "one tier wider": the nearby tier's own radius (radiusKm × 3) is often
  // still too tight, and the state tier's geoFilter excludes a different-
  // state vendor outright no matter how close they are — nationwide is the
  // only tier guaranteed to include every real candidate regardless of
  // distance or state. Deduped against what's already in `found`, sized by
  // computeFurtherCap. Fires its own recordActiveStoreExposure so the
  // "cooling period" it's chosen under actually accumulates history for next
  // time, same as products already do for their own rotation.
  const attachFurther = async (found, widerPool) => {
    const nearIds = new Set(found.results.map((r) => String(r.storeId)));
    const deduped = widerPool.filter((c) => !nearIds.has(String(c.store._id)));
    const cap = computeFurtherCap(found.results.length);
    const further = await pickFurtherResults(deduped, cap);
    recordActiveStoreExposure(further);
    return { ...found, furtherResults: further.map(mapResult), externalSuggestions: null };
  };

  if (!hasLocation) {
    const {
      candidates: nationwide,
      weakCandidates: nationwideWeak,
      relevanceFloor,
    } = await rankCandidates({ ...rankArgs, weights: NATIONWIDE_WEIGHTS });
    const found = tryTier(nationwide, nationwideWeak, relevanceFloor, "nationwide");
    // Nationwide is the widest tier that exists — nothing wider to source a
    // "further" bucket from.
    if (found) return { ...found, furtherResults: [], externalSuggestions: null };
    // No genuine match anywhere — same closest-near-miss-before-Places
    // cascade the located branch below uses, then Google Places itself.
    // Found live: this used to return straight to a dead end without ever
    // trying Places at all once there was no coordinate to search around
    // (see googlePlacesFallback's own comment on why it's still useful
    // with no coordinate).
    const weakFallback = weakByTier.find((w) => w.weakCandidates.length);
    if (weakFallback) {
      return {
        results: weakFallback.weakCandidates.map(mapResult),
        matchTier: weakFallback.matchTier,
        matchQuality: "similar",
        externalSuggestions: null,
        furtherResults: [],
      };
    }
    const externalSuggestions = await placesFallback(
      queryText,
      lat,
      lng,
      radiusKm,
    );
    return { results: [], matchTier: null, matchQuality: undefined, externalSuggestions, furtherResults: [] };
  }

  const locatedArgs = { ...rankArgs, lat, lng };

  const {
    candidates: local,
    weakCandidates: localWeak,
    relevanceFloor: localFloor,
  } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= radiusKm,
    proximityReferenceKm: radiusKm,
  });
  let found = tryTier(local, localWeak, localFloor, "local");

  // Country-wide pool for the "further" bonus bucket specifically — unlike
  // nationwideLookup below (the genuine last-resort tier, which deliberately
  // has no lat/lng — see its own comment), this one keeps real coordinates
  // so distanceKm and proximity scoring both still work within it.
  const furtherPoolLookup = () =>
    rankCandidates({
      ...locatedArgs,
      geoFilter: () => true,
      proximityReferenceKm: FURTHER_PROXIMITY_REFERENCE_KM,
    });
  const nationwideLookup = () => rankCandidates({ ...rankArgs, weights: NATIONWIDE_WEIGHTS });

  if (found) {
    const { candidates: furtherPool } = await furtherPoolLookup();
    return attachFurther(found, furtherPool);
  }

  const nearbyRadiusKm = radiusKm * NEARBY_RADIUS_MULTIPLIER;
  const {
    candidates: nearby,
    weakCandidates: nearbyWeak,
    relevanceFloor: nearbyFloor,
  } = await rankCandidates({
    ...locatedArgs,
    geoFilter: (_vendor, distanceKm) => distanceKm <= nearbyRadiusKm,
    proximityReferenceKm: nearbyRadiusKm,
  });
  found = tryTier(nearby, nearbyWeak, nearbyFloor, "nearby");

  if (found) {
    const { candidates: furtherPool } = await furtherPoolLookup();
    return attachFurther(found, furtherPool);
  }

  const buyerState = await reverseGeocodeState(lat, lng);
  const {
    candidates: stateWide,
    weakCandidates: stateWideWeak,
    relevanceFloor: stateFloor,
  } = buyerState
    ? await rankCandidates({
        ...locatedArgs,
        geoFilter: (vendor) =>
          Boolean(vendor.state) &&
          vendor.state.toLowerCase() === buyerState.toLowerCase(),
        proximityReferenceKm: STATE_PROXIMITY_REFERENCE_KM,
      })
    : { candidates: [], weakCandidates: [], relevanceFloor: null };
  found = tryTier(stateWide, stateWideWeak, stateFloor, "state");

  if (found) {
    const { candidates: furtherPool } = await furtherPoolLookup();
    return attachFurther(found, furtherPool);
  }

  const {
    candidates: nationwide,
    weakCandidates: nationwideWeak,
    relevanceFloor: nationwideFloor,
  } = await nationwideLookup();
  found = tryTier(nationwide, nationwideWeak, nationwideFloor, "nationwide");
  // Nationwide is itself the further-source for every other tier — nothing
  // wider exists to source a "further" bucket for nationwide's own matches.
  if (found) return { ...found, furtherResults: [], externalSuggestions: null };

  // No tier anywhere found a genuine match — fall back to the closest tier
  // that at least had a near-miss, before giving up to Google Places.
  const weakFallback = weakByTier.find((w) => w.weakCandidates.length);
  if (weakFallback) {
    return {
      results: weakFallback.weakCandidates.map(mapResult),
      matchTier: weakFallback.matchTier,
      matchQuality: "similar",
      externalSuggestions: null,
      furtherResults: [],
    };
  }

  const externalSuggestions = await placesFallback(queryText, lat, lng, radiusKm);

  return {
    results: [],
    matchTier: null,
    matchQuality: undefined,
    externalSuggestions,
    furtherResults: [],
  };
}
