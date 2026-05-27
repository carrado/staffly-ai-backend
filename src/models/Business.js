/**
 * Business Model — Multi-Tenant Store
 *
 * In production, replace the in-memory `businesses` Map with your database
 * (e.g. MongoDB, PostgreSQL). Each record represents one connected business.
 *
 * Schema per business:
 * {
 *   id:              string   — internal Staffly ID (e.g. "biz_1234")
 *   name:            string   — display name
 *   phone_number_id: string   — WhatsApp phone number ID (used to route webhooks)
 *   waba_id:         string   — WhatsApp Business Account ID
 *   access_token:    string   — long-lived Meta user access token (ENCRYPT in prod)
 *   connected_at:    Date
 *   is_test:         boolean  — true for dev/test businesses loaded from .env
 * }
 */

const businesses = new Map(); // businessId → business object

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export const addBusiness = (data) => {
  const id = data.id || `biz_${Date.now()}`;
  const business = {
    id,
    name: data.name || 'Unnamed Business',
    phone_number_id: data.phone_number_id,
    waba_id: data.waba_id,
    access_token: data.access_token,  // TODO: encrypt at rest in production
    velteUserId: data.velteUserId || null,
    aiConfig: data.aiConfig || {},
    connected_at: new Date(),
    is_test: data.is_test || false,
  };
  businesses.set(id, business);
  return business;
};

export const updateBusiness = (id, updates) => {
  const existing = businesses.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...updates };
  businesses.set(id, updated);
  return updated;
};

export const removeBusiness = (id) => businesses.delete(id);

// ─── Lookups ──────────────────────────────────────────────────────────────────

/**
 * Primary routing function: given the phone_number_id from an incoming
 * webhook, find which business it belongs to.
 */
export const getBusinessByPhoneNumberId = (phoneNumberId) => {
  for (const business of businesses.values()) {
    if (business.phone_number_id === phoneNumberId) return business;
  }
  return null;
};

export const getBusinessById = (id) => businesses.get(id) || null;

export const getAllBusinesses = () => Array.from(businesses.values());

// ─── Token management ─────────────────────────────────────────────────────────

export const updateBusinessToken = (id, accessToken) => {
  return updateBusiness(id, { access_token: accessToken });
};
