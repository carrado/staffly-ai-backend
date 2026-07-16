// Nominatim reverse-geocoding — moved here verbatim from velte-backend.
// Used only by retrieval.service.js's state-wide fallback tier: when a
// tight-radius search comes up empty, this resolves the buyer's coordinates
// to a state name so candidates can be re-filtered by `vendor.state` instead
// of distance.

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "Velte/1.0 (https://velte.ng)";
const TIMEOUT_MS = 6000;

/**
 * Resolve [lat, lng] to a Nigerian state name matching NIGERIA_STATES/
 * User.state exactly (Nominatim returns bare names like "Enugu", no "State"
 * suffix). Best-effort: returns null on any failure rather than throwing.
 */
export async function reverseGeocodeState(lat, lng) {
  try {
    const url = `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json();
    return data?.address?.state || null;
  } catch (err) {
    console.error("[nominatim] reverseGeocodeState failed:", err.message);
    return null;
  }
}
