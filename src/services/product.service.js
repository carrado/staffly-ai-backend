import mongoose from 'mongoose';
import { searchProductsFromList, formatAttributesForAI } from '../models/Products.js';
import { getBusinessById } from '../models/Business.js';
import { Product } from '../models/mongoose/Product.js';
import { ModifierOption } from '../models/mongoose/ModifierOption.js';
import { openai } from '../config/openai.js';
import { logger } from '../utils/logger.js';

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

// ─── Semantic search fallback ─────────────────────────────────────────────────

// Keyword scoring misses products whose copy never names what they are (e.g. a
// "Chuck Taylor High Top" whose text never says "shoe"). After the keyword
// pass, the model screens the UNMATCHED products and catches those by world
// knowledge of brands and product types.
const SEMANTIC_MAX_CANDIDATES = 150; // hard cap on products sent to the model
const SEMANTIC_DESC_CHARS = 160;     // description excerpt per product

const semanticCache = new Map(); // businessId → Map(query → { ids, expiresAt })

function getCachedSemanticIds(businessId, query) {
  const entry = semanticCache.get(businessId)?.get(query);
  return entry && Date.now() < entry.expiresAt ? entry.ids : null;
}

function setCachedSemanticIds(businessId, query, ids) {
  if (!semanticCache.has(businessId)) semanticCache.set(businessId, new Map());
  semanticCache.get(businessId).set(query, { ids, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Ask the model which of `candidates` a shopper searching `query` would expect
 * to see. Returns only ids that exist in `candidates`; an empty array on any
 * failure, so search degrades to keyword-only instead of breaking.
 */
async function semanticMatchIds(query, candidates) {
  const catalog = candidates.slice(0, SEMANTIC_MAX_CANDIDATES).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || '',
    tags: p.tags || [],
    description: (p.description || '').slice(0, SEMANTIC_DESC_CHARS),
  }));

  const prompt = `A customer is searching a store for: "${query}"

Below is a product catalog as JSON. Using your knowledge of brands and product types, return the ids of products a typical shopper with that search would expect to see (e.g. a "Chuck Taylor High Top" IS a shoe even if its text never says so).

Rules:
- Only include products that genuinely fit the search — when in doubt, leave it out.
- Only use ids from the catalog below. Never invent ids.
- Respond with JSON: {"matches": ["id1", "id2"]}. Use an empty array when nothing fits.

Catalog:
${JSON.stringify(catalog)}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const validIds = new Set(catalog.map((c) => c.id));
    return (Array.isArray(parsed.matches) ? parsed.matches : [])
      .map(String)
      .filter((id) => validIds.has(id));
  } catch (error) {
    logger.warn(
      `[Search] Semantic fallback failed (keyword results still returned): ${error.message}`,
    );
    return [];
  }
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

export async function searchProducts(businessId, query, limit = 50) {
  const all = await getProductsForBusiness(businessId);
  // Inquiries only ever list items still available — in stock for retail, on
  // today's menu (or pre-orderable) for food. Direct name lookups elsewhere
  // still find unavailable items so the AI can explain they're sold out.
  const available = all.filter((p) => p.is_available);
  const keywordMatches = searchProductsFromList(available, query, limit);

  // Broad "*" browses already list everything; specific searches get a second,
  // semantic pass over whatever the keyword scorer missed.
  if (!query || query.trim() === '*' || keywordMatches.length >= limit) {
    return keywordMatches;
  }

  const matchedIds = new Set(keywordMatches.map((p) => p.id));
  const candidates = available.filter((p) => !matchedIds.has(p.id));
  if (!candidates.length) return keywordMatches;

  const cacheKey = query.trim().toLowerCase();
  let extraIds = getCachedSemanticIds(businessId, cacheKey);
  if (extraIds === null) {
    extraIds = await semanticMatchIds(query, candidates);
    setCachedSemanticIds(businessId, cacheKey, extraIds);
  }

  // Cached ids are re-resolved against the CURRENT candidate set, so products
  // that sold out (or now match by keyword) drop out naturally.
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const extras = extraIds.map((id) => byId.get(id)).filter(Boolean);

  // Keyword matches keep their relevance ranking; semantic catches follow.
  return [...keywordMatches, ...extras].slice(0, limit);
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
