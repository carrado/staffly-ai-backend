import {
  searchProducts as findProducts,
  searchStores as findStores,
} from "../../services/retrieval.service.js";
import { AppError } from "../../middleware/errorHandler.js";

// ── POST /api/internal/match-buyer-request ──────────────────────────────────
// Internal, service-to-service only (guarded by verifyInternalSecret) —
// called from velte-backend when a Buyer Request is created. Reuses the
// SAME ranking engine as ordinary buyer search rather than a separate or
// simplified matcher, per the confirmed fork in
// docs/velte_buyer_requests_mvp_spec.md §62: this repo stays the single
// source of truth for semantic+proximity+trust ranking, never duplicated
// into velte-backend.
//
// A Buyer Request's text can describe either a specific item ("black
// senator outfit, size L") or a kind of help needed ("someone to repair my
// generator") — there's no live LLM turn here (unlike the buyer-facing AI
// chat, which picks between searchProducts/searchStores per turn) to decide
// which applies, so this runs BOTH and merges the matched vendor ids,
// deduped. Slightly broader than either alone, which is the right direction
// to err for a feature whose whole point (spec §14) is "don't
// reject/under-match, preserve the demand."
export async function matchBuyerRequest(req, res, next) {
  try {
    const { queryText, lat, lng, imageUrl } = req.body ?? {};
    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    const hasLat = typeof lat === "number";
    const hasLng = typeof lng === "number";

    const [productMatch, storeMatch] = await Promise.all([
      findProducts({
        queryText,
        lat: hasLat ? lat : undefined,
        lng: hasLng ? lng : undefined,
        isImageQuery: Boolean(imageUrl),
        imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
      }).catch((err) => {
        console.error("[matchBuyerRequest] product matching failed:", err.message);
        return { results: [] };
      }),
      findStores({
        queryText,
        lat: hasLat ? lat : undefined,
        lng: hasLng ? lng : undefined,
      }).catch((err) => {
        console.error("[matchBuyerRequest] store matching failed:", err.message);
        return { results: [] };
      }),
    ]);

    const vendorIds = new Set();
    for (const r of productMatch.results ?? []) vendorIds.add(String(r.vendorId));
    for (const r of storeMatch.results ?? []) vendorIds.add(String(r.vendorId));

    res.json({ success: true, data: { matchedVendorIds: [...vendorIds] } });
  } catch (err) {
    next(err);
  }
}
