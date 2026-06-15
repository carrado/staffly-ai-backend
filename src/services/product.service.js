import mongoose from 'mongoose';
import {
  searchProductsFromList,
  searchProductsFromListScored,
  formatAttributesForAI,
} from '../models/Products.js';
import { getBusinessById } from '../models/Business.js';
import { Product } from '../models/mongoose/Product.js';
import { ModifierOption } from '../models/mongoose/ModifierOption.js';
import { anthropic } from '../config/anthropic.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

// ─── Shape conversion ─────────────────────────────────────────────────────────

/**
 * WhatsApp image messages only accept JPEG/PNG — Meta accepts the send (200)
 * for other formats, then silently fails delivery. Cloudinary transcodes on
 * the fly based on the delivery URL, so rewrite non-JPEG/PNG Cloudinary URLs
 * to .jpg here, at the single point every product image flows through.
 */
function toWhatsappSafeImageUrl(url) {
  if (!url) return '';
  const isCloudinary = url.includes('res.cloudinary.com') && url.includes('/upload/');
  if (!isCloudinary || /\.(jpe?g|png)(\?|$)/i.test(url)) return url;
  return /\.\w+(\?|$)/.test(url)
    ? url.replace(/\.\w+(\?|$)/, '.jpg$1') // swap extension → Cloudinary delivers JPEG
    : url.replace('/upload/', '/upload/f_jpg/'); // no extension → force format param
}

/**
 * Batch-load every ModifierOption referenced by the given product docs.
 * Returns a Map of optionId → { name, additionalPrice } so conversion stays
 * synchronous and one query covers all products.
 */
async function loadModifierOptionMap(docs) {
  const ids = new Set();
  for (const doc of docs) {
    for (const group of doc.modifiers || []) {
      for (const id of group.options || []) ids.add(String(id));
    }
  }
  if (!ids.size) return new Map();

  const options = await ModifierOption.find({ _id: { $in: [...ids] } }).lean();
  return new Map(options.map((o) => [o._id.toString(), o]));
}

function toStafflyProduct(p, modifierOptionMap = new Map()) {
  // Velte stores attributes as [{ name, value }] pairs.
  // Group them into { Size: ['S','M','L'], Color: ['Black'] } for compatibility.
  const attrGroups = {};
  for (const attr of p.attributes || []) {
    if (!attrGroups[attr.name]) attrGroups[attr.name] = [];
    attrGroups[attr.name].push(attr.value);
  }

  // Food items: a dish is unavailable when toggled off OR when today's order
  // count has reached its daily limit (unless the vendor disabled the limit).
  const isFood = p.businessType === 'food' || p.estimatedPrepMins != null;
  const soldOutForToday =
    isFood &&
    !p.dailyLimitDisabled &&
    p.dailyLimit != null &&
    (p.dailyOrderCount || 0) >= p.dailyLimit;
  const foodAvailable = p.isCurrentlyAvailable !== false && !soldOutForToday;

  // Retail: sellable stock is what's on hand minus units already ordered, and
  // expired products can't be sold at all. Food docs carry stockQuantity: 0
  // (schema default) — never read it for food. Retail without a tracked
  // quantity gets the 999 "untracked" sentinel.
  const expired =
    !isFood &&
    p.expirationDate != null &&
    new Date(p.expirationDate).getTime() <= Date.now();
  const retailStock =
    p.stockQuantity == null
      ? 999
      : Math.max((p.stockQuantity || 0) - (p.orderedQuantity || 0), 0);
  const stock = isFood ? (foodAvailable ? 999 : 0) : expired ? 0 : retailStock;

  return {
    id: p._id.toString(),
    business_id: p.vendorId?.toString() || '',
    name: p.name,
    category: p.categoryId || '',
    description: p.description || '',
    // Prices are stored in the smallest unit (kobo); divide by 100 for Naira.
    price: (p.discountedPrice || p.price || 0) / 100,
    // 999 is the "untracked stock" sentinel — never show it as a literal count.
    stock,
    is_food: isFood,
    prep_time_mins: p.estimatedPrepMins ?? null,
    sold_out_for_today: soldOutForToday,
    allow_preorder: p.allowPreOrder === true,
    // Food modifier groups with options resolved to { name, additionalPrice }
    // (additionalPrice converted from kobo to Naira, like product prices).
    modifiers: (p.modifiers || [])
      .map((group) => ({
        name: group.name,
        required: group.required === true,
        multiSelect: group.multiSelect === true,
        options: (group.options || [])
          .map((id) => modifierOptionMap.get(String(id)))
          .filter(Boolean)
          .map((o) => ({ name: o.name, additionalPrice: (o.additionalPrice || 0) / 100 })),
      }))
      .filter((group) => group.options.length > 0),
    // "Still available" for inquiries: food = on the menu today (or
    // pre-orderable); retail = stock on hand (or untracked).
    is_available: isFood ? foodAvailable || p.allowPreOrder === true : stock > 0,
    allow_negotiation: p.isNegotiable || false,
    min_price: p.minimumPrice ? p.minimumPrice / 100 : null,
    image_url: toWhatsappSafeImageUrl(p.mainImageUrl),
    gallery: (p.thumbnailUrls || []).map(toWhatsappSafeImageUrl),
    tags: p.tags || [],
    useCases: [],
    attributes: attrGroups,
  };
}

// ─── Product cache ────────────────────────────────────────────────────────────

const productCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateProductCache(businessId) {
  productCache.delete(businessId);
  semanticCache.delete(businessId);
}

// ─── Semantic relevance ranking ───────────────────────────────────────────────

// Keyword scoring can't reason about FIT — it happily returns sneakers for
// "shoes for a wedding" because both are shoes. After the keyword pass the model
// re-judges the catalog against the FULL intent (product type AND the occasion /
// use-case / recipient / setting the shopper described) and sorts items into:
//   strong  — genuinely right for the request, occasion included
//   partial — same general kind of item but NOT the right fit (the closest we have)
// Anything unrelated is dropped. It also recovers items whose copy never names
// what they are (a "Chuck Taylor High Top" IS a shoe). Cached 5 min per query;
// any failure degrades to keyword-only.
const SEMANTIC_MAX_CANDIDATES = 150; // hard cap on products sent to the model
const SEMANTIC_DESC_CHARS = 160;     // description excerpt per product
const STRONG_SCORE = 100;            // matchPercent for a strong (occasion-fit) match
const PARTIAL_SCORE = 55;            // matchPercent for a closest-but-not-right match

// Schema-constrained output for the ranker — query specificity plus two id arrays.
const SEMANTIC_RANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specificity', 'strong', 'partial'],
  properties: {
    specificity: { type: 'string', enum: ['broad', 'specific'] },
    strong: { type: 'array', items: { type: 'string' } },
    partial: { type: 'array', items: { type: 'string' } },
  },
};

const semanticCache = new Map(); // businessId → Map(query → { ranking, expiresAt })

function getCachedRanking(businessId, query) {
  const entry = semanticCache.get(businessId)?.get(query);
  return entry && Date.now() < entry.expiresAt ? entry.ranking : null;
}

function setCachedRanking(businessId, query, ranking) {
  if (!semanticCache.has(businessId)) semanticCache.set(businessId, new Map());
  semanticCache.get(businessId).set(query, { ranking, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Rank `candidates` by how well each fits `query`, weighing the occasion /
 * use-case the shopper expressed, not just the product type. Returns
 * { strong: [ids], partial: [ids] } using only ids from `candidates`; returns
 * null on any failure so search degrades to keyword-only instead of breaking.
 */
async function semanticRank(query, candidates) {
  const catalog = candidates.slice(0, SEMANTIC_MAX_CANDIDATES).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || '',
    tags: p.tags || [],
    description: (p.description || '').slice(0, SEMANTIC_DESC_CHARS),
    ...(p.visualDescription ? { visual: p.visualDescription } : {}),
  }));
  if (!catalog.length) return null;

  const prompt = `A customer is shopping and searched for: "${query}"

First decide how specific the search is:
- "broad": just a product type or category with no narrowing detail (e.g. "shoes", "bags", "do you have dresses?"). The shopper hasn't said what they really want yet.
- "specific": it adds any constraint — occasion, use-case, setting, recipient, style, colour, size, material, brand, or budget (e.g. "shoes for a wedding", "red size 44 oxfords", "gift for my mum").

Then sort the products into two groups, using real-world knowledge (e.g. sneakers and canvas shoes are casual and are NOT appropriate for a wedding, while oxfords/brogues/loafers/dress shoes are; a hoodie is not office wear; a deep fryer is not "something healthy"):
- "strong": for a BROAD search, EVERY product of the requested type counts as strong — the shopper hasn't narrowed, so show the whole range. For a SPECIFIC search, a product is strong ONLY if it genuinely satisfies the stated details (the type AND the occasion/colour/size/etc.) — be strict.
- "partial": the right general kind of item that does NOT meet the stated details (e.g. casual sneakers when they asked for wedding shoes) — the closest thing available, not a real match. Usually empty for a broad search.
Leave a product out of both groups when it is unrelated. Include items that fit by world knowledge even if their text never says so (a "Chuck Taylor High Top" IS a shoe). When a product has a "visual" field, it was generated from the product's actual photo — trust it for the item's true style and formality over thin or generic text.

Only use ids from the catalog below; never invent ids. Respond with JSON: {"specificity": "broad" | "specific", "strong": ["id", ...], "partial": ["id", ...]}. Use empty arrays where nothing fits.

Catalog:
${JSON.stringify(catalog)}`;

  try {
    const completion = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
      output_config: {
        format: { type: 'json_schema', schema: SEMANTIC_RANK_SCHEMA },
      },
    });

    const raw =
      (completion.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('') || '{}';
    const parsed = JSON.parse(raw);
    const valid = new Set(catalog.map((c) => c.id));
    const clean = (arr) =>
      (Array.isArray(arr) ? arr : []).map(String).filter((id) => valid.has(id));
    const strong = clean(parsed.strong);
    const strongSet = new Set(strong);
    // A product can't be both tiers; strong wins.
    const partial = clean(parsed.partial).filter((id) => !strongSet.has(id));
    const specificity = parsed.specificity === 'broad' ? 'broad' : 'specific';
    return { specificity, strong, partial };
  } catch (error) {
    logger.warn(
      `[Search] Semantic ranking failed (keyword results still returned): ${error.message}`,
    );
    return null;
  }
}

// ─── Visual product understanding (optional, env.productVision) ─────────────────

// Vendor product text is often thin or mislabeled ("Men's Shoe"), leaving the
// ranker to guess. When PRODUCT_VISION is on, each product's photo is described
// once by the vision model and that description is fed to the ranker — so a
// "wedding shoes" request can be told apart from sneakers by how the item
// actually looks, for ANY product type. Cached per image URL (24h); failures
// degrade silently to text-only.
const VISION_MAX = 40;                            // most images described per ranking
const VISION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const visualCache = new Map();                    // imageUrl → { text, expiresAt }

async function describeProductImage(imageUrl) {
  if (!imageUrl) return null;
  const hit = visualCache.get(imageUrl);
  if (hit && Date.now() < hit.expiresAt) return hit.text;

  try {
    const completion = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 160,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            {
              type: 'text',
              text: 'Describe this product in ONE factual sentence for search matching: what the item is, its style and formality (casual vs formal/dressy), key colour/material if visible, and what occasions or uses it suits. No marketing language.',
            },
          ],
        },
      ],
    });
    const text =
      (completion.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim() || null;
    if (text) visualCache.set(imageUrl, { text, expiresAt: Date.now() + VISION_CACHE_TTL_MS });
    return text;
  } catch (error) {
    logger.warn(`[Vision] Image description failed (${imageUrl}): ${error.message}`);
    return null;
  }
}

// Attach a `visualDescription` (read from the product photo) to up to VISION_MAX
// of the given products. No-op unless PRODUCT_VISION is enabled.
async function attachVisualDescriptions(products) {
  if (env.productVision !== true) return products;

  const slice = products.slice(0, VISION_MAX);
  const described = await Promise.all(
    slice.map(async (p) => ({ id: p.id, text: await describeProductImage(p.image_url) })),
  );
  const byId = new Map(described.filter((d) => d.text).map((d) => [d.id, d.text]));
  return products.map((p) =>
    byId.has(p.id) ? { ...p, visualDescription: byId.get(p.id) } : p,
  );
}

// ─── Data source ──────────────────────────────────────────────────────────────

async function getProductsForBusiness(businessId) {
  const business = getBusinessById(businessId);
  if (!business?.velteUserId) return [];

  const cached = productCache.get(businessId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.products;
  }

  const docs = await Product.find({ vendorId: business.velteUserId }).lean();
  const optionMap = await loadModifierOptionMap(docs);
  const products = docs.map((doc) => toStafflyProduct(doc, optionMap));
  productCache.set(businessId, { products, expiresAt: Date.now() + CACHE_TTL_MS });
  return products;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Search for products matching `query`.
 *
 * Returns { products, specificity } where:
 *  - products: each carries a `matchPercent` (0–100, how well it fits), ordered
 *    strongest first. A semantic pass re-ranks by true fit (occasion/use-case
 *    included), so sneakers come back as "partial" (55), not strong (100), for
 *    "shoes for a wedding".
 *  - specificity: "broad" (a bare type, e.g. "shoes" — show a selection and
 *    invite narrowing) or "specific" (constraints given — match precisely).
 */
export async function searchProducts(businessId, query, limit = 50) {
  const all = await getProductsForBusiness(businessId);
  // Inquiries only ever list items still available — in stock for retail, on
  // today's menu (or pre-orderable) for food. Direct name lookups elsewhere
  // still find unavailable items so the AI can explain they're sold out.
  const available = all.filter((p) => p.is_available);
  // Copies, not cache objects — matchPercent is query-specific.
  const keywordMatches = searchProductsFromListScored(available, query, limit).map(
    ({ product, matchPercent }) => ({ ...product, matchPercent }),
  );

  // Broad "*" browses list everything as-is; only specific searches get the
  // semantic relevance pass.
  if (!query || query.trim() === '*') return { products: keywordMatches, specificity: 'broad' };

  // Candidate set for ranking: keyword matches first (most likely relevant, so
  // never dropped by the candidate cap), then the rest of the catalog so the
  // model can also recover items the keyword pass missed. The model re-tiers the
  // keyword matches AND catches misses in one pass.
  const keywordIds = new Set(keywordMatches.map((p) => p.id));
  const candidates = [
    ...keywordMatches,
    ...available.filter((p) => !keywordIds.has(p.id)),
  ];

  const cacheKey = query.trim().toLowerCase();
  let ranking = getCachedRanking(businessId, cacheKey);
  if (ranking === null) {
    // Enrich with photo-derived descriptions (no-op unless PRODUCT_VISION is on)
    // so the ranker can judge poorly-described items by how they actually look.
    const enriched = await attachVisualDescriptions(candidates);
    ranking = await semanticRank(query, enriched);
    setCachedRanking(businessId, cacheKey, ranking);
  }

  // Semantic pass unavailable, or it found nothing usable → keyword-only. We
  // have no specificity signal here, so default to "specific" (no extra nudging).
  if (!ranking || (!ranking.strong.length && !ranking.partial.length)) {
    return { products: keywordMatches, specificity: 'specific' };
  }

  // Re-resolve ids against the CURRENT available set, so anything that sold out
  // since the ranking was cached drops out naturally.
  const byId = new Map(available.map((p) => [p.id, p]));
  const keywordRank = new Map(keywordMatches.map((p, i) => [p.id, i]));
  // Within a tier, keep keyword hits first (in their score order); semantic-only
  // recoveries follow.
  const orderTier = (ids) =>
    [...ids].sort((a, b) => {
      const ra = keywordRank.has(a) ? keywordRank.get(a) : Infinity;
      const rb = keywordRank.has(b) ? keywordRank.get(b) : Infinity;
      return ra - rb;
    });
  const build = (ids, score) =>
    orderTier(ids)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((p) => ({ ...p, matchPercent: score }));

  const products = [
    ...build(ranking.strong, STRONG_SCORE),
    ...build(ranking.partial, PARTIAL_SCORE),
  ].slice(0, limit);

  return { products, specificity: ranking.specificity || 'specific' };
}

export async function getProductsByIds(ids) {
  if (!ids?.length) return [];

  const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
  if (!validIds.length) return [];

  const docs = await Product.find({ _id: { $in: validIds } }).lean();
  const optionMap = await loadModifierOptionMap(docs);

  // Preserve the caller's ordering (search relevance / pagination order).
  const byId = new Map(docs.map((doc) => [doc._id.toString(), doc]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((doc) => toStafflyProduct(doc, optionMap));
}

export async function getProductById(id) {
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await Product.findById(id).lean();
  if (!doc) return null;

  const optionMap = await loadModifierOptionMap([doc]);
  return toStafflyProduct(doc, optionMap);
}

export async function getProductByName(businessId, name) {
  const all = await getProductsForBusiness(businessId);
  return (
    all.find((p) => p.name.toLowerCase() === name.toLowerCase()) ||
    searchProductsFromList(all, name, 1)[0] ||
    null
  );
}

export async function getProductCategories(businessId) {
  const business = getBusinessById(businessId);
  if (!business?.velteUserId) return [];

  const docs = await Product.find({ vendorId: business.velteUserId }, { categoryId: 1 }).lean();
  return [...new Set(docs.map((d) => d.categoryId).filter(Boolean))];
}

// ─── Similar products (negotiable alternatives) ─────────────────────────────────

/**
 * Find this business's products that are similar to `baseProduct` AND negotiable.
 * "Similar" = same category OR at least one overlapping tag. Used to offer the
 * customer alternatives when a product is fixed-price or we can't reach their offer.
 * Ranked: same-category first, then more tag overlap, then cheaper.
 */
export async function findSimilarNegotiableProducts(businessId, baseProduct) {
  if (!baseProduct) return [];

  const all = await getProductsForBusiness(businessId);
  const baseCategory = String(baseProduct.category || '').toLowerCase();
  const baseTags = new Set((baseProduct.tags || []).map((t) => String(t).toLowerCase()));

  return all
    .filter((p) => p.id !== baseProduct.id && p.allow_negotiation === true && p.is_available)
    .map((p) => {
      const sameCategory =
        !!baseCategory && String(p.category || '').toLowerCase() === baseCategory;
      const tagOverlap = (p.tags || []).reduce(
        (count, t) => (baseTags.has(String(t).toLowerCase()) ? count + 1 : count),
        0,
      );
      return { product: p, sameCategory, tagOverlap };
    })
    .filter(({ sameCategory, tagOverlap }) => sameCategory || tagOverlap > 0)
    .sort((a, b) => {
      if (a.sameCategory !== b.sameCategory) return a.sameCategory ? -1 : 1;
      if (b.tagOverlap !== a.tagOverlap) return b.tagOverlap - a.tagOverlap;
      return a.product.price - b.product.price;
    })
    .map(({ product }) => product);
}

// ─── Attribute checking ───────────────────────────────────────────────────────

export function checkAttribute(product, attributeKey, requestedValue) {
  const attrs = product.attributes || {};

  const matchedKey = Object.keys(attrs).find(
    (k) => k.toLowerCase() === attributeKey.toLowerCase(),
  );

  if (!matchedKey) {
    return {
      available: false,
      error: `This product does not have a "${attributeKey}" attribute`,
      available_options: [],
    };
  }

  const options = attrs[matchedKey];
  const optionsList = Array.isArray(options) ? options : [String(options)];

  if (!requestedValue) {
    return { available: true, available_options: optionsList };
  }

  const match = optionsList.find(
    (o) => String(o).toLowerCase() === requestedValue.toLowerCase(),
  );

  return {
    available: !!match,
    value: match || null,
    available_options: optionsList,
  };
}

// ─── Context builder for AI ───────────────────────────────────────────────────

export function buildProductContext(product) {
  // NOTE: never include min_price here. The minimum acceptable price is a
  // hidden floor and must never reach the model's prompt (see negotiation rules).
  const lines = [
    `Name: ${product.name}`,
    `Category: ${product.category || 'uncategorized'}`,
    `Description: ${product.description}`,
    `Price: ₦${product.price.toLocaleString()}`,
    `Stock: ${product.stock}`,
    `Negotiable: ${product.allow_negotiation ? 'yes' : 'no'}`,
    `Attributes: ${formatAttributesForAI(product)}`,
  ];

  for (const group of product.modifiers || []) {
    const opts = group.options
      .map((o) => (o.additionalPrice > 0 ? `${o.name} (+₦${o.additionalPrice.toLocaleString()})` : o.name))
      .join(', ');
    const rule = group.required
      ? group.multiSelect ? 'required, pick one or more' : 'required, pick one'
      : 'optional';
    lines.push(`Modifier — ${group.name} (${rule}): ${opts}`);
  }

  return lines.join('\n');
}
