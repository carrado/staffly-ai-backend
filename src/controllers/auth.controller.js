/**
 * Auth Controller — Embedded Signup / OAuth
 *
 * This handles the Meta Embedded Signup flow that allows ANY business owner
 * to connect their WhatsApp Business Account to Staffly.
 *
 * Flow:
 *   1. Business owner clicks "Connect WhatsApp" in your frontend.
 *   2. Meta's Embedded Signup popup opens and the user authorises your app.
 *   3. Meta redirects to GET /auth/meta/callback?code=...
 *   4. We exchange the code for a long-lived token and fetch their WABA details.
 *   5. We save the business record and their encrypted token.
 */

import axios from 'axios';
import { addBusiness, getBusinessById, getAllBusinesses, removeBusiness } from '../models/Business.js';
import { clearAllSessionsForBusiness } from '../models/ConversationState.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const GRAPH_URL = 'https://graph.facebook.com/v22.0';

export async function handleMetaCallback(req, res) {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code parameter');

    // ── Step 1: Exchange code for short-lived token ───────────────────────────
    const tokenResp = await axios.get(`${GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        redirect_uri: env.metaRedirectUri,
        code,
      },
    });
    const shortToken = tokenResp.data.access_token;

    // ── Step 2: Exchange for long-lived token (60 days) ───────────────────────
    const longTokenResp = await axios.get(`${GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        fb_exchange_token: shortToken,
      },
    });
    const longToken = longTokenResp.data.access_token;

    // ── Step 3: Get the WABA ID associated with this token ────────────────────
    const businessResp = await axios.get(
      `${GRAPH_URL}/me?fields=name,whatsapp_business_accounts`,
      { headers: { Authorization: `Bearer ${longToken}` } }
    );
    const wabaList = businessResp.data.whatsapp_business_accounts?.data || [];
    if (!wabaList.length) throw new Error('No WhatsApp Business Account found on this Meta account');

    const wabaId = wabaList[0].id;
    const businessName = businessResp.data.name || 'Unnamed Business';

    // ── Step 4: Get the Phone Number ID under this WABA ───────────────────────
    const phoneResp = await axios.get(`${GRAPH_URL}/${wabaId}/phone_numbers`, {
      headers: { Authorization: `Bearer ${longToken}` },
    });
    const phones = phoneResp.data.data || [];
    if (!phones.length) throw new Error('No phone numbers found on this WABA');

    const phoneNumberId = phones[0].id;
    const phoneNumber = phones[0].display_phone_number;

    // ── Step 5: Store the business ────────────────────────────────────────────
    // In production: encrypt longToken before storing
    const business = addBusiness({
      name: businessName,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: longToken,
    });

    logger.info(`✅ New business connected: ${businessName} (${business.id}) | Phone: ${phoneNumber}`);

    // Redirect back to your frontend dashboard
    return res.redirect(`${env.baseUrl}/dashboard?connected=true&businessId=${business.id}`);
  } catch (error) {
    logger.error('Meta Embedded Signup callback error:', error.response?.data || error.message);
    return res.status(500).send('WhatsApp connection failed. Please try again.');
  }
}

/**
 * Disconnect a business — removes their record and clears sessions.
 * Called when a business owner disconnects WhatsApp from your dashboard.
 */
export async function disconnectBusiness(req, res) {
  try {
    const { businessId } = req.params;
    const business = getBusinessById(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found' });

    // TODO: revoke Meta token here
    // await axios.delete(`${GRAPH_URL}/me/permissions`, { headers: { Authorization: `Bearer ${business.access_token}` }});

    clearAllSessionsForBusiness(businessId);
    removeBusiness(businessId);

    logger.info(`Business disconnected: ${businessId}`);
    return res.json({ success: true });
  } catch (error) {
    logger.error('Disconnect error:', error);
    return res.status(500).json({ error: 'Disconnect failed' });
  }
}

export async function listBusinesses(req, res) {
  const businesses = getAllBusinesses().map(({ access_token, ...safe }) => safe);
  return res.json({ businesses });
}
