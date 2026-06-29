/**
 * WhatsApp Service
 *
 * All functions accept `accessToken` as a parameter so they work for
 * ANY connected business — not just a single hardcoded one.
 */

import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger.js';
import { translateUiString } from './openai.service.js';

const GRAPH_URL = 'https://graph.facebook.com/v22.0';

// Axios has NO default timeout — without one, a dead socket hangs the message
// handler forever. Every Meta call gets a hard cap so failures surface and
// fall back instead of getting stuck.
const SEND_TIMEOUT_MS = 15000;
const MEDIA_TIMEOUT_MS = 30000;

// ─── Basic message senders ────────────────────────────────────────────────────

// The WhatsApp message id (WAMID) Meta assigns to a message we just sent. The
// reply-to-card feature keys off this: storing it against the product lets us
// resolve which card a customer swipe-replied to (their reply carries this id
// in `message.context.id`).
const sentWamid = (res) => res?.data?.messages?.[0]?.id ?? null;

export async function sendTextMessage(phoneNumberId, accessToken, to, text) {
  const res = await axios.post(
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
  return sentWamid(res);
}

export async function sendImageMessage(phoneNumberId, accessToken, to, imageUrl, caption) {
  const res = await axios.post(
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
  return sentWamid(res);
}

// Send an image that's ALREADY uploaded to Meta (by media id, not a link).
// Media sent by id is on Meta's servers, so it delivers fast and in order —
// before any follow-up button — which a link-fetched image can't guarantee.
export async function sendImageMessageById(phoneNumberId, accessToken, to, mediaId, caption) {
  const res = await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { id: mediaId, caption },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: SEND_TIMEOUT_MS,
    }
  );
  return sentWamid(res);
}

// ─── Media-id cache (link → uploaded Meta media id) ───────────────────────────
//
// Sending a product photo by `link` makes Meta fetch the URL before delivering,
// so the image bubble lags behind the lightweight follow-up button and arrives
// out of order. Uploading the image once to Meta and sending it by `id` removes
// that fetch from the send path, so the card lands first. Media ids are scoped
// to the uploading phone number, so the cache is keyed by phoneNumberId + url.
// Bounded LRU with a TTL well inside Meta's media retention window.
const MEDIA_ID_CACHE_MAX = 2000;
const MEDIA_ID_TTL_MS = 12 * 60 * 60 * 1000; // 12h

class MediaIdCache extends Map {
  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value); // most-recently-used
    return value;
  }
  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (this.size > MEDIA_ID_CACHE_MAX) {
      super.delete(super.keys().next().value); // evict least-recently-used
    }
    return this;
  }
}

const mediaIdCache = new MediaIdCache();

const mediaCacheKey = (phoneNumberId, imageUrl) => `${phoneNumberId}:${imageUrl}`;

// Download the image and upload it to Meta, returning a reusable media id.
async function uploadImageByUrl(phoneNumberId, accessToken, imageUrl) {
  const fileRes = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: MEDIA_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  // Meta only accepts JPEG/PNG here (sendableImageUrl already screens out the
  // rest); trust the served content-type, defaulting to jpeg.
  const contentType = (fileRes.headers['content-type'] || '').toLowerCase();
  const mimeType = contentType.includes('png') ? 'image/png' : 'image/jpeg';
  const filename = mimeType === 'image/png' ? 'product.png' : 'product.jpg';

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', Buffer.from(fileRes.data), { filename, contentType: mimeType });

  const uploadRes = await axios.post(`${GRAPH_URL}/${phoneNumberId}/media`, form, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...form.getHeaders(),
    },
    timeout: MEDIA_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const mediaId = uploadRes.data?.id;
  if (!mediaId) throw new Error('Meta /media upload returned no id');
  return mediaId;
}

// Resolve a usable media id for an image url, uploading (and caching) on a miss.
async function resolveMediaId(phoneNumberId, accessToken, imageUrl) {
  const key = mediaCacheKey(phoneNumberId, imageUrl);
  const cached = mediaIdCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.mediaId;

  const mediaId = await uploadImageByUrl(phoneNumberId, accessToken, imageUrl);
  mediaIdCache.set(key, { mediaId, expiresAt: Date.now() + MEDIA_ID_TTL_MS });
  return mediaId;
}

// Send a product's photo + caption as one image bubble, preferring the media-id
// path (delivers in order) and degrading gracefully: media-id → link → text.
// A rejected cached id (expired/deleted on Meta's side) is dropped and retried
// via the link path so a stale cache never swallows a card.
// Returns the WAMID of whichever message actually delivered (image bubble, or
// the text fallback) so callers can map it back to the product.
async function sendProductImageBubble(phoneNumberId, accessToken, to, product, caption) {
  const imageUrl = sendableImageUrl(product);
  if (!imageUrl) {
    return sendTextMessage(phoneNumberId, accessToken, to, caption);
  }

  try {
    const mediaId = await resolveMediaId(phoneNumberId, accessToken, imageUrl);
    return await sendImageMessageById(phoneNumberId, accessToken, to, mediaId, caption);
  } catch (err) {
    mediaIdCache.delete(mediaCacheKey(phoneNumberId, imageUrl));
    logger.warn(
      `[WhatsApp] media-id image send failed for "${product.name}", falling back to link: ${err.response?.data?.error?.message || err.message}`,
    );
  }

  try {
    return await sendImageMessage(phoneNumberId, accessToken, to, imageUrl, caption);
  } catch (err) {
    logger.warn(`[WhatsApp] Image failed for product "${product.name}": ${err.message}`);
    return sendTextMessage(phoneNumberId, accessToken, to, caption);
  }
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
 * A product's full, WhatsApp-sendable photo set: the main image first, then the
 * gallery thumbnails — deduped, and screened the same way sendableImageUrl
 * screens the main image (drop blanks, placeholder domains, and formats Meta
 * can't deliver). Returns [] when the product has no usable photo.
 */
export function productPhotoUrls(product) {
  const candidates = [product?.image_url, ...(product?.gallery || [])];
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url || seen.has(url) || url.includes('example.com')) continue;
    if (UNSUPPORTED_IMAGE_EXT.test(url)) {
      logger.warn(`[WhatsApp] Skipping gallery photo — unsupported format: ${url}`);
      continue;
    }
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Send a list of image URLs as plain image bubbles — "just the photos", no card
 * chrome, no caption. Each photo prefers the media-id path (ordered delivery)
 * and falls back to a link; a photo that fails both is skipped so the rest still
 * arrive. A small gap between sends keeps them in order. Returns the WAMIDs of
 * the bubbles that actually delivered (so callers can map them back to a product
 * for reply-to-photo resolution).
 */
export async function sendProductPhotos(phoneNumberId, accessToken, to, imageUrls = []) {
  const wamids = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    let wamid = null;
    try {
      const mediaId = await resolveMediaId(phoneNumberId, accessToken, url);
      wamid = await sendImageMessageById(phoneNumberId, accessToken, to, mediaId, '');
    } catch (err) {
      mediaIdCache.delete(mediaCacheKey(phoneNumberId, url));
      try {
        wamid = await sendImageMessage(phoneNumberId, accessToken, to, url, '');
      } catch (err2) {
        logger.warn(
          `[WhatsApp] photo send failed (${url}): ${err2.response?.data?.error?.message || err2.message}`,
        );
      }
    }
    if (wamid) wamids.push(wamid);
    if (i < imageUrls.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
  return wamids;
}

// Fixed card labels per conversation language. Product descriptions are
// translated upstream (openai.service translateDescriptions) — this table covers
// everything composed in code. English and Pidgin are hand-written; any other
// language is filled in by getCaptionStrings below. Button titles must stay
// within Meta's 20-character limit.
const CAPTION_STRINGS = {
  english: {
    price: (p) => `💰 Price: ₦${p}`,
    sizes: (v) => `📐 Sizes: ${v}`,
    colors: (v) => `🎨 Colors: ${v}`,
    material: (v) => `🧵 Material: ${v}`,
    gender: (v) => `👤 Gender: ${v}`,
    chooseOne: 'choose one',
    chooseAtLeastOne: 'choose at least one',
    optional: 'optional',
    readyIn: (m) => `⏱️ Ready in ~${m} mins`,
    availableNow: '🍽️ Available now',
    soldOutToday: '🚫 Sold out for today',
    preOrders: '📅 Pre-orders accepted',
    inStock: '📦 In stock',
    stockCount: (n) => `📦 Stock: ${n} available`,
    negotiable: '✅ Price is negotiable',
    pickButton: '🛒 Pick this one',
  },
  pidgin: {
    price: (p) => `💰 Price na ₦${p}`,
    sizes: (v) => `📐 Sizes wey dey: ${v}`,
    colors: (v) => `🎨 Colors wey dey: ${v}`,
    material: (v) => `🧵 Material: ${v}`,
    gender: (v) => `👤 Gender: ${v}`,
    chooseOne: 'pick one',
    chooseAtLeastOne: 'pick at least one',
    optional: 'if you want',
    readyIn: (m) => `⏱️ E go ready in ~${m} mins`,
    availableNow: '🍽️ E dey available now',
    soldOutToday: '🚫 E don finish for today',
    preOrders: '📅 You fit pre-order am',
    inStock: '📦 E dey in stock',
    stockCount: (n) => `📦 Na ${n} remain`,
    negotiable: '✅ You fit price am small',
    pickButton: '🛒 Na this one',
  },
};

// Card label chrome for any language. English and Pidgin are hand-written above;
// for every other language the bare label words are AI-translated once and
// cached, while emojis, ₦, numbers and values are added in code so they never
// get mangled. Returns a table shaped exactly like a CAPTION_STRINGS entry.
const captionTableCache = new Map(); // language -> table

async function getCaptionStrings(language) {
  const lang = (language || 'english').toLowerCase().trim();
  if (CAPTION_STRINGS[lang]) return CAPTION_STRINGS[lang];
  if (captionTableCache.has(lang)) return captionTableCache.get(lang);

  const tr = (text) => translateUiString(text, lang);
  const [
    price, sizes, colors, material, gender,
    chooseOne, chooseAtLeastOne, optional, readyIn,
    availableNow, soldOutToday, preOrders, inStock,
    remain, negotiable, pickButton,
  ] = await Promise.all([
    tr('Price'), tr('Sizes'), tr('Colors'), tr('Material'), tr('Gender'),
    tr('choose one'), tr('choose at least one'), tr('optional'), tr('Ready in'),
    tr('Available now'), tr('Sold out for today'), tr('Pre-orders accepted'), tr('In stock'),
    tr('available'), tr('Price is negotiable'), tr('Pick this one'),
  ]);

  const table = {
    price: (p) => `💰 ${price}: ₦${p}`,
    sizes: (v) => `📐 ${sizes}: ${v}`,
    colors: (v) => `🎨 ${colors}: ${v}`,
    material: (v) => `🧵 ${material}: ${v}`,
    gender: (v) => `👤 ${gender}: ${v}`,
    chooseOne,
    chooseAtLeastOne,
    optional,
    readyIn: (m) => `⏱️ ${readyIn} ~${m} mins`,
    availableNow: `🍽️ ${availableNow}`,
    soldOutToday: `🚫 ${soldOutToday}`,
    preOrders: `📅 ${preOrders}`,
    inStock: `📦 ${inStock}`,
    stockCount: (n) => `📦 ${n} ${remain}`,
    negotiable: `✅ ${negotiable}`,
    // Meta caps interactive button titles at 20 characters (emoji included).
    pickButton: `🛒 ${pickButton}`.slice(0, 20),
  };

  captionTableCache.set(lang, table);
  return table;
}

/**
 * Build the image caption for a product card.
 * Shows name, price, all attributes, and negotiability.
 *
 * WhatsApp captions support basic formatting:
 *   *bold*  _italic_  ~strikethrough~
 */
async function buildProductCaption(product, language = 'english') {
  const s = await getCaptionStrings(language);
  const attrs = product.attributes || {};
  const lines = [];

  // Name + price
  lines.push(`*${product.name}*`);
  lines.push(product.description);
  lines.push(s.price(product.price.toLocaleString()));

  // Known attribute keys with icons
  if (attrs.sizes?.length)   lines.push(s.sizes(attrs.sizes.join(', ')));
  if (attrs.colors?.length)  lines.push(s.colors(attrs.colors.join(', ')));
  if (attrs.material)        lines.push(s.material(attrs.material));
  if (attrs.gender)          lines.push(s.gender(attrs.gender));

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
      ? group.multiSelect ? s.chooseAtLeastOne : s.chooseOne
      : s.optional;
    lines.push(`🍴 ${group.name} (${rule}): ${opts}`);
  }

  // Availability — food shows prep time and "available today", retail shows
  // stock (999 is the untracked-stock sentinel, shown as just "In stock").
  if (product.is_food) {
    if (product.prep_time_mins) lines.push(s.readyIn(product.prep_time_mins));
    lines.push(product.stock > 0 ? s.availableNow : s.soldOutToday);
    if (product.stock <= 0 && product.allow_preorder) lines.push(s.preOrders);
  } else if (product.stock === 999) {
    lines.push(s.inStock);
  } else {
    lines.push(s.stockCount(product.stock));
  }
  if (product.allow_negotiation) lines.push(s.negotiable);

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
// Returns { cardWamid, followUpWamid }: the WAMID of the card (the image bubble)
// AND the WAMID of the follow-up conversational text bubble (when one is sent).
// Both are reply targets — the follow-up text is the bottom-most message in the
// chat and the one customers most often swipe-reply to — so the caller can track
// each: a reply to the card resolves to this product, a reply to the follow-up
// resolves to its text.
export async function sendProductCard(phoneNumberId, accessToken, to, product, followUpText = '', language = 'english') {
  const caption = await buildProductCaption(product, language);

  // Image (by media id so it delivers before the follow-up), falling back to
  // link then a plain text card.
  const cardWamid = await sendProductImageBubble(phoneNumberId, accessToken, to, product, caption);

  // Send the AI's conversational response as a separate follow-up bubble
  let followUpWamid = null;
  if (followUpText) {
    await new Promise((r) => setTimeout(r, 300)); // slight delay for natural feel
    followUpWamid = await sendTextMessage(phoneNumberId, accessToken, to, followUpText);
  }

  return { cardWamid, followUpWamid };
}

// Interactive-message limits (Meta API)
const INTERACTIVE_BODY_LIMIT = 1024;

/**
 * Send one product as a SINGLE interactive message:
 *   • an image header (the product photo),
 *   • a body carrying the FULL details, and
 *   • a "Pick this one" reply button whose id encodes the product
 *     (`select_product:<id>`) so the webhook can resolve the tap.
 *
 * Because it's one message, the photo is ALWAYS rendered above the button — Meta
 * can't reorder a single message the way it can two separate bubbles. The
 * trade-off is that WhatsApp may collapse a long body behind a "Read more" tap
 * (an image caption stays fully visible); guaranteed ordering is worth that.
 *
 * Robust degradation: prefer an already-uploaded media id for the header, fall
 * back to the raw image link, then — if the image fails the whole message —
 * retry with no header (details + button still land), and finally a plain text
 * card so the customer always gets something.
 */
export async function sendProductButtonCard(phoneNumberId, accessToken, to, product, language = 'english') {
  const caption = await buildProductCaption(product, language);
  const labels = await getCaptionStrings(language);

  // Full details live in the interactive body (capped at Meta's limit).
  const body = caption.slice(0, INTERACTIVE_BODY_LIMIT);

  // Resolve the photo into an image header. Prefer a media id (pre-uploaded,
  // reliable); fall back to a raw link; with no usable image, send no header.
  let header = null;
  const imageUrl = sendableImageUrl(product);
  if (imageUrl) {
    try {
      const mediaId = await resolveMediaId(phoneNumberId, accessToken, imageUrl);
      header = { type: 'image', image: { id: mediaId } };
    } catch (err) {
      mediaIdCache.delete(mediaCacheKey(phoneNumberId, imageUrl));
      logger.warn(
        `[WhatsApp] media-id upload failed for "${product.name}", using image link in header: ${err.response?.data?.error?.message || err.message}`,
      );
      header = { type: 'image', image: { link: imageUrl } };
    }
  }

  const buildPayload = (withHeader) => ({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(withHeader && header ? { header } : {}),
      body: { text: body },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `select_product:${product.id}`, title: labels.pickButton },
          },
        ],
      },
    },
  });

  const post = (payload) =>
    axios.post(`${GRAPH_URL}/${phoneNumberId}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: SEND_TIMEOUT_MS,
    });

  try {
    return sentWamid(await post(buildPayload(true)));
  } catch (err) {
    // A bad image header can reject the whole message. Retry once without it so
    // the details + Pick button still reach the customer.
    if (header) {
      logger.warn(
        `[WhatsApp] interactive card with image failed for "${product.name}", retrying without image: ${err.response?.data?.error?.message || err.message}`,
      );
      try {
        return sentWamid(await post(buildPayload(false)));
      } catch (err2) {
        logger.warn(
          `[WhatsApp] interactive card retry failed for "${product.name}", falling back to text: ${err2.response?.data?.error?.message || err2.message}`,
        );
      }
    }
    // Last resort: a plain text card so the customer at least gets the details.
    return await sendTextMessage(phoneNumberId, accessToken, to, caption);
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
// Returns { cards, headerWamid, footerWamid }: `cards` is an array of
// { productId, wamid } (one per card, for reply-to-card lookups); headerWamid /
// footerWamid are the WAMIDs of the intro and "show more" text bubbles so the
// caller can track them as reply targets too.
export async function sendProductList(phoneNumberId, accessToken, to, products, headerText = '', footerText = '', language = 'english') {
  if (!products.length) return { cards: [], headerWamid: null, footerWamid: null };

  // Send the AI's intro text first
  let headerWamid = null;
  if (headerText) {
    headerWamid = await sendTextMessage(phoneNumberId, accessToken, to, headerText);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Send each product card with a gap between them
  const cards = [];
  let sent = 0;
  for (const product of products) {
    const wamid = await sendProductButtonCard(phoneNumberId, accessToken, to, product, language);
    cards.push({ productId: product.id, wamid });
    sent += 1;
    logger.info(`[WhatsApp] Card ${sent}/${products.length} sent ("${product.name}")`);
    await new Promise((r) => setTimeout(r, 500)); // 500ms between cards
  }

  let footerWamid = null;
  if (footerText) {
    footerWamid = await sendTextMessage(phoneNumberId, accessToken, to, footerText);
  }

  return { cards, headerWamid, footerWamid };
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

/**
 * Show the "typing…" bubble while we put the reply together — the same way you
 * see it when a person is typing on WhatsApp.
 *
 * On WhatsApp Cloud API this is one call that BOTH marks the inbound message as
 * read AND requests the indicator (it's keyed off the message id, not the
 * recipient). The bubble shows for up to ~25s and clears automatically the
 * instant we send our reply — so we fire it as soon as the message arrives, then
 * build and send the response. Falls back to a plain read receipt on older API
 * versions that don't accept `typing_indicator`, so the read ticks still show.
 */
export async function sendTypingIndicator(phoneNumberId, accessToken, messageId) {
  const url = `${GRAPH_URL}/${phoneNumberId}/messages`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  try {
    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
      { headers, timeout: SEND_TIMEOUT_MS },
    );
  } catch {
    // Older API versions reject the typing_indicator field — still mark the
    // message read so the customer at least sees the blue ticks.
    try {
      await axios.post(
        url,
        { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
        { headers, timeout: SEND_TIMEOUT_MS },
      );
    } catch {
      // non-critical — never block the response
    }
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
