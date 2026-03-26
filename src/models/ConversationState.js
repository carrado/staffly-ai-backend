// Key: `${businessId}:${customerNumber}`
const sessions = new Map();

export const getSession = (businessId, customerNumber) => {
  const key = `${businessId}:${customerNumber}`;
  return sessions.get(key) || {};
};

export const setSession = (businessId, customerNumber, data) => {
  const key = `${businessId}:${customerNumber}`;
  sessions.set(key, { ...getSession(businessId, customerNumber), ...data });
};

export const clearSession = (businessId, customerNumber) => {
  const key = `${businessId}:${customerNumber}`;
  sessions.delete(key);
};

export const setLastProduct = (businessId, customerNumber, product) => {
  const session = getSession(businessId, customerNumber);
  session.lastProduct = product;
  setSession(businessId, customerNumber, session);
};

export const setNegotiation = (businessId, customerNumber, negotiation) => {
  const session = getSession(businessId, customerNumber);
  session.negotiation = negotiation;
  setSession(businessId, customerNumber, session);
};

export const clearNegotiation = (businessId, customerNumber) => {
  const session = getSession(businessId, customerNumber);
  delete session.negotiation;
  setSession(businessId, customerNumber, session);
};