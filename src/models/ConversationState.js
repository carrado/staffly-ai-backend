/**
 * ConversationState Model — Multi-Tenant, Mongo-backed
 *
 * Keyed by `businessId:customerNumber` so each business has fully isolated
 * conversation state.
 *
 * An in-memory Map stays the hot path: every getter/setter is synchronous so
 * the many call sites across the request handler are untouched. Durability is
 * layered underneath:
 *   - hydrateSession() loads a customer's saved state from Mongo into the cache
 *     the first time they're seen in this process (call it once per request,
 *     before any sync access). This is what lets absence detection — and the
 *     rest of the session — survive a restart.
 *   - every write is mirrored to Mongo (debounced per key) so the cache and the
 *     database stay in sync without blocking the reply.
 */

import { ConversationSession } from './mongoose/ConversationSession.js';
import { logger } from '../utils/logger.js';

const sessions = new Map();

const makeKey = (businessId, customerNumber) => `${businessId}:${customerNumber}`;

// businessId never contains a colon; customerNumber is bare digits — so the
// first colon is the only boundary that matters.
const splitKey = (key) => {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
};

// ─── Persistence (write-through, debounced) ─────────────────────────────────

const PERSIST_DEBOUNCE_MS = 50; // coalesce the several writes within one turn
const pendingTimers = new Map(); // key -> debounce timer
const dirty = new Set(); // keys with unwritten changes
const inFlight = new Map(); // key -> in-progress persist promise

function schedulePersist(key) {
  dirty.add(key);
  if (pendingTimers.has(key)) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    void persist(key);
  }, PERSIST_DEBOUNCE_MS);
  timer.unref?.(); // a pending flush must never hold the process open
  pendingTimers.set(key, timer);
}

async function persist(key) {
  if (!dirty.has(key)) return inFlight.get(key); // nothing new to write
  dirty.delete(key); // claim it — a write during the await re-marks it dirty

  const run = (async () => {
    const state = sessions.get(key);
    if (!state) return; // cleared before the flush ran
    const [businessId, customerNumber] = splitKey(key);
    try {
      await ConversationSession.updateOne(
        { businessId, customerNumber },
        { $set: { state, lastMessageAt: state.lastMessageAt || null } },
        { upsert: true },
      );
    } catch (err) {
      dirty.add(key); // failed — keep it dirty so a later flush retries
      logger.error(`[Session] Persist failed for ${key}: ${err.message}`);
    }
  })();

  inFlight.set(key, run);
  try {
    await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

/**
 * Persist every pending write immediately and wait for it to land. Call this on
 * shutdown (SIGTERM/SIGINT) so the debounce window can't drop the final writes
 * of a turn — notably the lastMessageAt that absence detection depends on.
 */
export async function flushAllPending() {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();

  // Persist whatever is still dirty, and await anything already mid-write.
  await Promise.allSettled([
    ...inFlight.values(),
    ...[...dirty].map((key) => persist(key)),
  ]);
}

function writeThrough(key, value) {
  sessions.set(key, value);
  schedulePersist(key);
}

// ─── Hydration ──────────────────────────────────────────────────────────────

/**
 * Load a customer's persisted session into the cache if it isn't already there.
 * Must be awaited once per request before any synchronous getSession/setSession
 * call so a post-restart process sees their real lastMessageAt and history.
 */
export async function hydrateSession(businessId, customerNumber) {
  const key = makeKey(businessId, customerNumber);
  if (sessions.has(key)) return sessions.get(key);

  try {
    const doc = await ConversationSession.findOne({
      businessId,
      customerNumber,
    }).lean();
    const state = doc?.state || {};
    sessions.set(key, state);
    return state;
  } catch (err) {
    // On a read error, don't poison the cache — return empty and let the next
    // message retry the load rather than locking in a blank session.
    logger.error(`[Session] Hydrate failed for ${key}: ${err.message}`);
    return {};
  }
}

// ─── Synchronous cache API (unchanged signatures) ───────────────────────────

export const getSession = (businessId, customerNumber) =>
  sessions.get(makeKey(businessId, customerNumber)) || {};

export const setSession = (businessId, customerNumber, data) => {
  const key = makeKey(businessId, customerNumber);
  writeThrough(key, { ...(sessions.get(key) || {}), ...data });
};

export const clearSession = (businessId, customerNumber) => {
  const key = makeKey(businessId, customerNumber);
  sessions.delete(key);
  ConversationSession.deleteOne({ businessId, customerNumber }).catch((err) =>
    logger.error(`[Session] Delete failed for ${key}: ${err.message}`),
  );
};

export const setLastProduct = (businessId, customerNumber, product) => {
  const session = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, { ...session, lastProduct: product });
};

export const setNegotiation = (businessId, customerNumber, negotiation) => {
  const session = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, { ...session, negotiation });
};

export const clearNegotiation = (businessId, customerNumber) => {
  const key = makeKey(businessId, customerNumber);
  // Full replace (not a merge) so the negotiation field is genuinely dropped
  // from both the cache and the persisted document.
  const { negotiation, ...rest } = sessions.get(key) || {};
  writeThrough(key, rest);
};

// ─── Abandoned-checkout follow-up ───────────────────────────────────────────

/**
 * Drop a pending payment follow-up (full replace so the field is removed, not
 * merged back). Called whenever the customer sends a new message — any further
 * engagement means we should NOT later nudge them about that checkout.
 */
export const clearPendingFollowUp = (businessId, customerNumber) => {
  const key = makeKey(businessId, customerNumber);
  const cached = sessions.get(key);
  if (!cached?.pendingFollowUp) return;
  const { pendingFollowUp, ...rest } = cached;
  writeThrough(key, rest);
};

/**
 * Mark a follow-up as delivered so the sweeper never re-sends it, and record it
 * in the conversation history so a reply stays grounded. `message` may be null
 * (e.g. when we skip sending because the order turned out to be paid).
 */
export async function markFollowUpSent(businessId, customerNumber, message = null) {
  await hydrateSession(businessId, customerNumber);
  const session = getSession(businessId, customerNumber);
  if (!session.pendingFollowUp) return;
  setSession(businessId, customerNumber, {
    ...session,
    pendingFollowUp: { ...session.pendingFollowUp, sentAt: new Date() },
    conversationHistory: message
      ? [...(session.conversationHistory || []), { role: 'assistant', content: message }]
      : session.conversationHistory,
  });
}

/**
 * Cancel a follow-up by its order id — used by the payment webhook when a
 * payment confirms. Goes through Mongo (not the in-memory Order map) so it works
 * even after a restart, and keeps the in-memory cache in sync if loaded.
 */
export async function cancelFollowUpForOrder(orderId) {
  if (!orderId) return;
  let doc;
  try {
    doc = await ConversationSession.findOne({
      'state.pendingFollowUp.orderId': orderId,
    }).lean();
  } catch (err) {
    logger.error(`[Session] Follow-up cancel lookup failed for ${orderId}: ${err.message}`);
    return;
  }
  if (!doc) return;

  const key = makeKey(doc.businessId, doc.customerNumber);
  const cached = sessions.get(key);
  if (cached?.pendingFollowUp) {
    const { pendingFollowUp, ...rest } = cached;
    sessions.set(key, rest);
  }

  try {
    await ConversationSession.updateOne(
      { businessId: doc.businessId, customerNumber: doc.customerNumber },
      { $unset: { 'state.pendingFollowUp': '' } },
    );
  } catch (err) {
    logger.error(`[Session] Follow-up cancel update failed for ${orderId}: ${err.message}`);
  }
}

// Utility: wipe all sessions for a given business (e.g. when disconnected)
export const clearAllSessionsForBusiness = (businessId) => {
  for (const key of sessions.keys()) {
    if (key.startsWith(`${businessId}:`)) sessions.delete(key);
  }
  ConversationSession.deleteMany({ businessId }).catch((err) =>
    logger.error(`[Session] Bulk delete failed for ${businessId}: ${err.message}`),
  );
};
