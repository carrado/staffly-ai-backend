/**
 * Keep-Alive Self-Ping
 *
 * Free hosting tiers (Render, Railway, fly.io, ...) put the service to sleep
 * after ~15 minutes without inbound traffic. A sleeping instance cold-starts
 * on the next request — slow enough that a buyer's search may time out or
 * get retried. Pinging our own /health endpoint keeps the instance warm.
 *
 * Straight copy of velte-backend's src/initializers/keepAlive.js — same
 * shape, different service pinging its own URL.
 */

const PING_INTERVAL_MS = 10 * 60 * 1000; // comfortably under the ~15-min idle cutoff
const PING_TIMEOUT_MS = 30 * 1000; // generous — a waking instance answers slowly

export function startKeepAlive() {
  const baseUrl = process.env.BASE_URL;

  // Pinging localhost defeats the purpose, and dev servers are allowed to sleep.
  if (
    process.env.NODE_ENV !== "production" ||
    !baseUrl ||
    baseUrl.includes("localhost")
  ) {
    console.log(
      "[KeepAlive] Skipped (requires NODE_ENV=production and a public BASE_URL)",
    );
    return;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/health`;

  const timer = setInterval(async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.warn(`[KeepAlive] Ping returned ${res.status}`);
      }
    } catch (err) {
      // Failures only — a success line every 10 minutes is just log noise.
      console.warn(`[KeepAlive] Ping failed: ${err.message}`);
    } finally {
      clearTimeout(abortTimer);
    }
  }, PING_INTERVAL_MS);

  // The pinger must never be the thing keeping a shutting-down process alive.
  timer.unref();

  console.log(
    `[KeepAlive] Self-ping every ${PING_INTERVAL_MS / 60000} min → ${url}`,
  );
}
