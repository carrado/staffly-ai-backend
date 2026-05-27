/**
 * WhatsApp Service
 *
 * All functions accept `accessToken` as a parameter so they work for
 * ANY connected business — not just a single hardcoded one.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const GRAPH_URL = 'https://graph.facebook.com/v22.0';

// ─── Basic message senders ────────────────────────────────────────────────────

export async function sendTextMessage(phoneNumberId, accessToken, to, text) {
  await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

export async function sendImageMessage(phoneNumberId, accessToken, to, imageUrl, caption) {
  await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

export async function sendAudioMessage(phoneNumberId, accessToken, to, audioUrl) {
  await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      audio: { link: audioUrl },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ─── Product card helpers ─────────────────────────────────────────────────────

/**
 * Build the image caption for a product card.
 * Shows name, price, all attributes, and negotiability.
 *
 * WhatsApp captions support basic formatting:
 *   *bold*  _italic_  ~strikethrough~
 */
function buildProductCaption(product) {
  const attrs = product.attributes || {};
  const lines = [];

  // Name + price
  lines.push(`*${product.name}*`);
  lines.push(product.description);
  lines.push(`💰 Price: ₦${product.price.toLocaleString()}`);

  // Known attribute keys with icons
  if (attrs.sizes?.length)   lines.push(`📐 Sizes: ${attrs.sizes.join(', ')}`);
  if (attrs.colors?.length)  lines.push(`🎨 Colors: ${attrs.colors.join(', ')}`);
  if (attrs.material)        lines.push(`🧵 Material: ${attrs.material}`);
  if (attrs.gender)          lines.push(`👤 Gender: ${attrs.gender}`);

  // Any other custom attributes (dimensions, weight, fit, etc.)
  const knownKeys = new Set(['sizes', 'colors', 'material', 'gender']);
  Object.entries(attrs).forEach(([key, value]) => {
    if (!knownKeys.has(key.toLowerCase())) {
      const val = Array.isArray(value) ? value.join(', ') : value;
      lines.push(`• ${key}: ${val}`);
    }
  });

  // Stock + negotiability
  lines.push(`📦 Stock: ${product.stock} available`);
  if (product.allow_negotiation) lines.push('✅ Price is negotiable');

  return lines.filter(Boolean).join('\n');
}

/**
 * Send a single product to a customer.
 *
 * Sequence:
 *   1. Image message with full product details as caption
 *   2. Optional follow-up text (the AI's conversational response)
 *
 * Falls back to text-only if no image URL is set.
 */
export async function sendProductCard(phoneNumberId, accessToken, to, product, followUpText = '') {
  const caption = buildProductCaption(product);
  const hasRealImage = product.image_url && !product.image_url.includes('example.com');

  if (hasRealImage) {
    try {
      await sendImageMessage(phoneNumberId, accessToken, to, product.image_url, caption);
    } catch (err) {
      // Image failed — fall back to plain text card
      logger.warn(`[WhatsApp] Image failed for product "${product.name}": ${err.message}`);
      await sendTextMessage(phoneNumberId, accessToken, to, caption);
    }
  } else {
    // No image — send text card
    await sendTextMessage(phoneNumberId, accessToken, to, caption);
  }

  // Send the AI's conversational response as a separate follow-up bubble
  if (followUpText) {
    await new Promise((r) => setTimeout(r, 300)); // slight delay for natural feel
    await sendTextMessage(phoneNumberId, accessToken, to, followUpText);
  }
}

/**
 * Send multiple product cards.
 * Used when a search returns more than one result.
 *
 * Sequence:
 *   1. Header text (the AI's intro message)
 *   2. One product card per result
 */
export async function sendProductList(phoneNumberId, accessToken, to, products, headerText = '') {
  if (!products.length) return;

  // Send the AI's intro text first
  if (headerText) {
    await sendTextMessage(phoneNumberId, accessToken, to, headerText);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Send each product card with a gap between them
  for (const product of products) {
    await sendProductCard(phoneNumberId, accessToken, to, product);
    await new Promise((r) => setTimeout(r, 500)); // 500ms between cards
  }
}

// ─── Media download ───────────────────────────────────────────────────────────

export async function downloadMedia(mediaId, accessToken) {
  const mediaRes = await axios.get(
    `${GRAPH_URL}/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const mediaUrl = mediaRes.data.url;
  const mimeType = mediaRes.data.mime_type || "audio/ogg";

  const fileRes = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType,
  };
}


// ─── Webhook subscription ─────────────────────────────────────────────────────

/**
 * Subscribe a business's WABA to your webhook after Embedded Signup.
 * Called automatically in auth.controller.js when a business connects.
 */
export async function registerWebhookForBusiness(wabaId, accessToken) {
  try {
    await axios.post(
      `${GRAPH_URL}/${wabaId}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    logger.info(`[WhatsApp] Webhook registered for WABA ${wabaId}`);
  } catch (err) {
    logger.error('[WhatsApp] Failed to register webhook:', err.response?.data || err.message);
  }
}
