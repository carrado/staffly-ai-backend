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