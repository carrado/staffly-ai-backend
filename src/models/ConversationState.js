/**
 * ConversationState Model — Multi-Tenant
 *
 * Keyed by `businessId:customerNumber` so each business has fully isolated
 * conversation state. In production, use Redis or a DB for persistence.
 */

const sessions = new Map();

const makeKey = (businessId, customerNumber) => `${businessId}:${customerNumber}`;

export const getSession = (businessId, customerNumber) =>
  sessions.get(makeKey(businessId, customerNumber)) || {};

export const setSession = (businessId, customerNumber, data) => {
  const key = makeKey(businessId, customerNumber);
  sessions.set(key, { ...getSession(businessId, customerNumber), ...data });
};

export const clearSession = (businessId, customerNumber) =>
  sessions.delete(makeKey(businessId, customerNumber));

export const setLastProduct = (businessId, customerNumber, product) => {
  const session = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, { ...session, lastProduct: product });
};

export const setNegotiation = (businessId, customerNumber, negotiation) => {
  const session = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, { ...session, negotiation });
};

export const clearNegotiation = (businessId, customerNumber) => {
  const session = getSession(businessId, customerNumber);
  const { negotiation, ...rest } = session;
  setSession(businessId, customerNumber, rest);
};

// Utility: wipe all sessions for a given business (e.g. when disconnected)
export const clearAllSessionsForBusiness = (businessId) => {
  for (const key of sessions.keys()) {
    if (key.startsWith(`${businessId}:`)) sessions.delete(key);
  }
};
