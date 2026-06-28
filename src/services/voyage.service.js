/**
 * Voyage AI multimodal embeddings (voyage-multimodal-3).
 *
 * Option B of visual product search: embed images into vectors and rank product
 * photos by cosine similarity to a customer's photo, so a "find me something
 * like this" lookalike is matched by how items actually LOOK — not just how
 * they're described. Text and images share one vector space.
 *
 * Disabled (every export no-ops / returns null) unless VOYAGE_API_KEY is set, so
 * visual search degrades cleanly to the vision→text path (Option A).
 *
 * NOTE: the request/response shape below targets Voyage's multimodal embeddings
 * endpoint — verify field names against the current Voyage docs before relying
 * on it in production, as the API may have evolved.
 */

import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
const MODEL = 'voyage-multimodal-3';

const FETCH_TIMEOUT_MS = 15000; // downloading a product image
const EMBED_TIMEOUT_MS = 30000; // the Voyage call itself
const PRODUCT_BATCH = 8; // product images per Voyage request (base64 is heavy)

const CLAUDE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isVisualSearchEnabled() {
  return !!env.voyageApiKey;
}

// Cosine similarity of two equal-length vectors. Returns -Infinity for missing
// or mismatched vectors so they sort to the bottom of a ranking.
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return -Infinity;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return -Infinity;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bufferToDataUrl(buffer, mimeType) {
  const mime = CLAUDE_IMAGE_TYPES.has(mimeType) ? mimeType : 'image/jpeg';
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function fetchImageAsDataUrl(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const ct = (res.headers['content-type'] || '').toLowerCase();
  const mime = ct.includes('png')
    ? 'image/png'
    : ct.includes('webp')
      ? 'image/webp'
      : ct.includes('gif')
        ? 'image/gif'
        : 'image/jpeg';
  return `data:${mime};base64,${Buffer.from(res.data).toString('base64')}`;
}

// One Voyage multimodal call. `inputType` is "query" for the shopper's photo and
// "document" for catalogue products — the asymmetric encoding Voyage recommends
// for retrieval. Returns an array of embedding vectors aligned to `inputs`.
async function callVoyage(inputs, inputType) {
  const res = await axios.post(
    VOYAGE_URL,
    { inputs, model: MODEL, input_type: inputType },
    {
      headers: {
        Authorization: `Bearer ${env.voyageApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: EMBED_TIMEOUT_MS,
    },
  );
  return (res.data?.data || []).map((d) => d.embedding);
}

/**
 * Embed the shopper's photo (a Buffer) as a query vector. Null when visual
 * search is disabled or the call fails — the caller then stays on Option A.
 */
export async function embedImageQuery({ buffer, mimeType }) {
  if (!isVisualSearchEnabled() || !buffer) return null;
  try {
    const dataUrl = bufferToDataUrl(buffer, mimeType);
    const [vec] = await callVoyage(
      [{ content: [{ type: 'image_base64', image_base64: dataUrl }] }],
      'query',
    );
    return Array.isArray(vec) ? vec : null;
  } catch (e) {
    logger.warn(
      `[Voyage] query image embed failed: ${e.response?.data?.detail || e.message}`,
    );
    return null;
  }
}

/**
 * Embed product images as document vectors. `items` is [{ id, imageUrl }];
 * returns a Map id → vector. Images are fetched individually (a single broken
 * URL never sinks the batch) and embedded in small batches to keep payloads
 * sane. Missing/failed items are simply absent from the returned Map.
 */
export async function embedProductImages(items) {
  const out = new Map();
  if (!isVisualSearchEnabled() || !items?.length) return out;

  for (let i = 0; i < items.length; i += PRODUCT_BATCH) {
    const batch = items.slice(i, i + PRODUCT_BATCH);

    // Fetch each image to a data URL, dropping any that fail.
    const fetched = await Promise.all(
      batch.map(async (it) => {
        try {
          return { id: it.id, dataUrl: await fetchImageAsDataUrl(it.imageUrl) };
        } catch (e) {
          logger.warn(`[Voyage] image fetch failed (${it.imageUrl}): ${e.message}`);
          return null;
        }
      }),
    );
    const usable = fetched.filter(Boolean);
    if (!usable.length) continue;

    try {
      const vectors = await callVoyage(
        usable.map((u) => ({
          content: [{ type: 'image_base64', image_base64: u.dataUrl }],
        })),
        'document',
      );
      vectors.forEach((vec, j) => {
        if (Array.isArray(vec)) out.set(usable[j].id, vec);
      });
    } catch (e) {
      logger.warn(
        `[Voyage] product embed batch failed: ${e.response?.data?.detail || e.message}`,
      );
    }
  }

  return out;
}
