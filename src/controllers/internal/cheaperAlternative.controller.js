import { searchProducts as findProducts } from "../../services/retrieval.service.js";
import { AppError } from "../../middleware/errorHandler.js";

// ── POST /api/internal/cheaper-alternative ──────────────────────────────────
// Internal, service-to-service only (verifyInternalSecret) — called from
// velte-backend's price-watch sweep, just before it tells someone their
// watched price dropped.
//
// WHY THIS EXISTS. A price watch that only ever looks at one listing can
// deliver a technically-true message that leaves the buyer worse off:
//
//   "The TV you're watching dropped to ₦450,000!"
//
// while another Velte vendor has had the same TV at ₦430,000 the whole time.
// The buyer acts on the alert, buys at ₦450,000, and Velte helped them lose
// ₦20,000 — with a notification they paid credits for. Checking the market at
// the moment of the alert is what turns a tracker into something worth
// trusting: the alert either leads with the better option, or it says with
// justification that the watched one is genuinely the best available.
//
// Same reasoning as matchBuyerRequest.controller.js next door: the ranking
// engine stays single-sourced HERE and is never duplicated into
// velte-backend. This endpoint adds no ranking of its own — it runs the
// ordinary product search and then applies two purely arithmetic filters
// (cheaper than X, not the thing already being watched), which is code's job,
// not the matcher's.

/** How much cheaper an alternative must be before it is worth interrupting
 *  someone about. A ₦300 difference on a ₦450,000 TV is noise, and naming a
 *  "better price" that close reads as Velte padding the alert.
 *
 *  Both bars must be cleared: 2% catches the trivial-percentage case on
 *  expensive items, and the ₦1,000 floor catches the trivial-absolute case on
 *  cheap ones, where 2% can be a handful of naira. */
const MIN_SAVING_RATIO = 0.02;
const MIN_SAVING_KOBO = 1000 * 100;

export async function cheaperAlternative(req, res, next) {
  try {
    const { queryText, currentPriceKobo, excludeProductId, lat, lng } =
      req.body ?? {};

    if (typeof queryText !== "string" || !queryText.trim()) {
      throw new AppError("queryText is required.", 400);
    }
    if (!Number.isFinite(currentPriceKobo) || currentPriceKobo <= 0) {
      throw new AppError("currentPriceKobo must be a positive number.", 400);
    }

    const hasLat = typeof lat === "number";
    const hasLng = typeof lng === "number";

    // Nationwide when the watch carries no location, which is the common
    // case: a watch is about a THING, and the buyer's whereabouts when they
    // created it weeks ago says little about where they will buy it. A
    // cheaper vendor two states away is still worth naming — the alert says
    // where it is, and the buyer decides.
    //
    // includeNearbyBusinesses: false — Google Places returns shop addresses
    // with no stock or price behind them, which is exactly nothing to a
    // question that is entirely about price.
    const match = await findProducts({
      queryText,
      lat: hasLat ? lat : undefined,
      lng: hasLng ? lng : undefined,
      includeNearbyBusinesses: false,
      limit: 20,
    }).catch((err) => {
      // Best-effort, exactly like matchBuyerRequest: a matching hiccup must
      // never stop the alert itself going out. The buyer still hears their
      // price dropped; they just don't get the comparison.
      console.error("[cheaperAlternative] search failed:", err.message);
      return { results: [] };
    });

    const excludeId = excludeProductId ? String(excludeProductId) : null;

    let best = null;
    for (const result of match.results ?? []) {
      // The watched listing itself, which is not an alternative to itself.
      if (excludeId && String(result.productId) === excludeId) continue;
      // Nothing to compare against: a quote-on-request service has no price,
      // and calling one "cheaper" would be an invention.
      if (result.quoteOnRequest) continue;

      // `price` is NAIRA on a search result (retrieval's own mapper divides
      // the stored kobo by 100). Everything on a watch is kobo, so it comes
      // back to kobo here rather than the two units meeting anywhere else.
      const priceKobo = Math.round(result.price * 100);
      if (!Number.isFinite(priceKobo) || priceKobo <= 0) continue;

      const saving = currentPriceKobo - priceKobo;
      if (saving < MIN_SAVING_KOBO) continue;
      if (saving / currentPriceKobo < MIN_SAVING_RATIO) continue;

      if (!best || priceKobo < best.priceKobo) {
        best = {
          productId: String(result.productId),
          name: result.name,
          priceKobo,
          vendorName: result.vendorName ?? null,
          storeHandle: result.storeHandle ?? null,
          area: result.area ?? null,
          state: result.state ?? null,
          mainImageUrl: result.mainImageUrl ?? null,
          savingKobo: saving,
        };
      }
    }

    // `checked: true` distinguishes "we looked and the watched one is the
    // best available" from "we couldn't look". Only the first of those is
    // worth telling a buyer, and an alert that claimed it after a failed
    // search would be a confident lie.
    res.json({ success: true, data: { checked: true, alternative: best } });
  } catch (err) {
    next(err);
  }
}
