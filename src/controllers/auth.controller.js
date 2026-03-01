import axios from 'axios';
import { addBusiness } from '../models/Business.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export async function handleMetaCallback(req, res) {
  try {
    const code = req.query.code;

    // Exchange code for short-lived token
    const tokenResponse = await axios.get('https://graph.facebook.com/v22.0/oauth/access_token', {
      params: {
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        redirect_uri: env.metaRedirectUri,
        code,
      },
    });
    const shortToken = tokenResponse.data.access_token;

    // Exchange for long-lived token
    const longTokenResponse = await axios.get('https://graph.facebook.com/v22.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        fb_exchange_token: shortToken,
      },
    });
    const longToken = longTokenResponse.data.access_token;

    // Get WhatsApp Business Account ID
    const businessResp = await axios.get('https://graph.facebook.com/v22.0/me?fields=whatsapp_business_accounts', {
      headers: { Authorization: `Bearer ${longToken}` },
    });
    const wabaId = businessResp.data.whatsapp_business_accounts.data[0].id;

    // Get phone number ID
    const phoneResp = await axios.get(`https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`, {
      headers: { Authorization: `Bearer ${longToken}` },
    });
    const phoneNumberId = phoneResp.data.data[0].id;

    // Store business
    const business = addBusiness({
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      access_token: longToken,
    });

    logger.info('New business connected:', business.id);
    res.send('WhatsApp Connected Successfully 🎉');
  } catch (error) {
    logger.error('Meta callback error:', error.response?.data || error.message);
    res.status(500).send('Connection failed');
  }
}