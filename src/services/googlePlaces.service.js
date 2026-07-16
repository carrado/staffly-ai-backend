// Google Places API (New) — Tier 5 fallback for searchStores/searchProducts,
// only reached when Velte has no matching vendor in the local, nearby,
// state, or nationwide tier. Moved here verbatim from velte-backend — only
// ever called by this repo's retrieval.service.js.
//
// FieldMask requests places.id, places.displayName, places.formattedAddress,
// places.location and nothing else. displayName/formattedAddress/location
// together stay in the Text Search "Pro" SKU ($32/1,000 requests). `id` is
// free to add alongside them: it lives in the cheapest "IDs Only" SKU, and a
// request bills at the highest tier any of its requested fields belongs to.
// It's needed as a stable dedupe key for recruitment-lead logging. Adding
// any Enterprise-tier field (ratings, reviews, photos, phone number) would
// push the cost into a pricier tier — deliberately not requested.

const PLACES_SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location";
const TIMEOUT_MS = 6000;

/**
 * Real nearby businesses matching `queryText`, biased toward [lat, lng]
 * within `radiusKm`. Best-effort: returns null on any failure rather than
 * throwing.
 */
export async function searchNearbyBusinesses({ queryText, lat, lng, radiusKm = 10 }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(PLACES_SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: queryText,
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Math.min(radiusKm * 1000, 50000), // API caps at 50km
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(
        `[googlePlaces] searchText failed: ${res.status} ${await res.text()}`,
      );
      return null;
    }

    const data = await res.json();
    const places = Array.isArray(data?.places) ? data.places : [];
    return places
      .map((place) => ({
        placeId: place.id || null,
        name: place.displayName?.text || null,
        address: place.formattedAddress || null,
        lat: place.location?.latitude,
        lng: place.location?.longitude,
      }))
      .filter(
        (p) =>
          p.placeId &&
          p.name &&
          p.address &&
          typeof p.lat === "number" &&
          typeof p.lng === "number",
      );
  } catch (err) {
    console.error("[googlePlaces] searchNearbyBusinesses failed:", err.message);
    return null;
  }
}
