/**
 * WhatsApp Service
 *
 * All functions accept `accessToken` as a parameter so they work for
 * ANY connected business — not just a single hardcoded one.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const GRAPH_URL = 'https://graph.facebook.com/v22.0';

// Axios has NO default timeout — without one, a dead socket hangs the message
// handler forever. Every Meta call gets a hard cap so failures surface and
// fall back instead of getting stuck.
const SEND_TIMEOUT_MS = 15000;
const MEDIA_TIMEOUT_MS = 30000;

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
      timeout: SEND_TIMEOUT_MS,
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
      timeout: SEND_TIMEOUT_MS,
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
      timeout: SEND_TIMEOUT_MS,
    }
  );
}

// ─── Product card helpers ─────────────────────────────────────────────────────

// WhatsApp image messages/headers only accept JPEG and PNG. A link to any
// other format passes the API call (HTTP 200) but fails delivery
// asynchronously — the customer receives nothing.
const UNSUPPORTED_IMAGE_EXT = /\.(webp|gif|svg|avif|bmp|tiff?|heic)(\?|$)/i;

/**
 * Return the product's image URL if it's usable in a WhatsApp message,
 * otherwise null (no image, placeholder domain, or a format Meta can't
 * deliver — those cards go out as text instead).
 */
export function sendableImageUrl(product) {
  const url = product.image_url;
  if (typeof url !== 'string' || !url.trim() || url.includes('example.com')) {
    return null;
  }
  if (UNSUPPORTED_IMAGE_EXT.test(url)) {
    logger.warn(
      `[WhatsApp] Skipping image for "${product.name}" — unsupported format: ${url}`,
    );
    return null;
  }
  return url;
}

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

  // Food modifier groups (choice of protein, toppings, ...)
  for (const group of product.modifiers || []) {
    const opts = group.options
      .map((o) => (o.additionalPrice > 0 ? `${o.name} +₦${o.additionalPrice.toLocaleString()}` : o.name))
      .join(', ');
    const rule = group.required
      ? group.multiSelect ? 'choose at least one' : 'choose one'
      : 'optional';
    lines.push(`🍴 ${group.name} (${rule}): ${opts}`);
  }

  // Availability — food shows prep time and "available today", retail shows
  // stock (999 is the untracked-stock sentinel, shown as just "In stock").
  if (product.is_food) {
    if (product.prep_time_mins) lines.push(`⏱️ Ready in ~${product.prep_time_mins} mins`);
    lines.push(product.stock > 0 ? '🍽️ Available now' : '🚫 Sold out for today');
    if (product.stock <= 0 && product.allow_preorder) lines.push('📅 Pre-orders accepted');
  } else if (product.stock === 999) {
    lines.push('📦 In stock');
  } else {
    lines.push(`📦 Stock: ${product.stock} available`);
  }
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
  const imageUrl = sendableImageUrl(product);

  if (imageUrl) {
    try {
      await sendImageMessage(phoneNumberId, accessToken, to, imageUrl, caption);
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

// Interactive-message limits (Meta API)
const INTERACTIVE_BODY_LIMIT = 1024;

/**
 * Send one product as an interactive card: image header (when available),
 * full details as the body, and a "Pick this one" reply button whose id
 * encodes the product (`select_product:<id>`) so the webhook can resolve
 * the tap back to the exact product.
 *
 * Falls back to a plain image/text card if the interactive send fails.
 */
export async function sendProductButtonCard(phoneNumberId, accessToken, to, product) {
  const caption = buildProductCaption(product).slice(0, INTERACTIVE_BODY_LIMIT);
  const imageUrl = sendableImageUrl(product);

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: caption },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `select_product:${product.id}`, title: '🛒 Pick this one' },
          },
        ],
      },
    },
  };

  if (imageUrl) {
    payload.interactive.header = { type: 'image', image: { link: imageUrl } };
  }

  try {
    await axios.post(`${GRAPH_URL}/${phoneNumberId}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: SEND_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn(
      `[WhatsApp] Button card failed for product "${product.name}": ${err.response?.data?.error?.message || err.message}`,
    );
    await sendProductCard(phoneNumberId, accessToken, to, product);
  }
}

/**
 * Send multiple product cards.
 * Used when a search returns one or more results.
 *
 * Sequence:
 *   1. Header text (the AI's intro message)
 *   2. One interactive image card per result, each with a "Pick this one" button
 *   3. Footer text (e.g. the "show more" hint), after the last card
 */
export async function sendProductList(phoneNumberId, accessToken, to, products, headerText = '', footerText = '') {
  if (!products.length) return;

  // Send the AI's intro text first
  if (headerText) {
    await sendTextMessage(phoneNumberId, accessToken, to, headerText);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Send each product card with a gap between them
  let sent = 0;
  for (const product of products) {
    await sendProductButtonCard(phoneNumberId, accessToken, to, product);
    sent += 1;
    logger.info(`[WhatsApp] Card ${sent}/${products.length} sent ("${product.name}")`);
    await new Promise((r) => setTimeout(r, 500)); // 500ms between cards
  }

  if (footerText) {
    await sendTextMessage(phoneNumberId, accessToken, to, footerText);
  }
}

// ─── Presence / status ───────────────────────────────────────────────────────

export async function markMessageAsRead(phoneNumberId, accessToken, messageId) {
  try {
    await axios.post(
      `${GRAPH_URL}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: SEND_TIMEOUT_MS },
    );
  } catch {
    // non-critical — never block the response
  }
}

export async function sendTypingIndicator(phoneNumberId, accessToken, to) {
  try {
    await axios.post(
      `${GRAPH_URL}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'typing' },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: SEND_TIMEOUT_MS },
    );
  } catch {
    // typing indicators not supported on all accounts — fail silently
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
      timeout: SEND_TIMEOUT_MS,
    }
  );

  const mediaUrl = mediaRes.data.url;
  const mimeType = mediaRes.data.mime_type || "audio/ogg";

  const fileRes = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    timeout: MEDIA_TIMEOUT_MS,
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
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: SEND_TIMEOUT_MS }
    );
    logger.info(`[WhatsApp] Webhook registered for WABA ${wabaId}`);
  } catch (err) {
    logger.error('[WhatsApp] Failed to register webhook:', err.response?.data || err.message);
  }
}
