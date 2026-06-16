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
import { buildTaxConfig, computeTax } from '../utils/pricing.js';

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

  // VAT is folded into every customer-facing price here: the number the shopper
  // sees, negotiates on, and pays already includes tax — it's only ever rendered
  // as "Price", never broken out. With no tax config this is a no-op. Applied to
  // the list price, the negotiation floor, and modifier add-ons alike so the
  // whole basket is consistently tax-inclusive.
  const taxCfg = buildTaxConfig(p);
  const withVat = (naira) => computeTax(naira, taxCfg).gross;

  return {
    id: p._id.toString(),
    business_id: p.vendorId?.toString() || '',
    name: p.name,
    category: p.categoryId || '',
    description: p.description || '',
    // Prices are stored in the smallest unit (kobo); divide by 100 for Naira,
    // then fold in VAT so the shown price is the all-in price.
    price: withVat((p.discountedPrice || p.price || 0) / 100),
    // 999 is the "untracked stock" sentinel — never show it as a literal count.
    stock,
    is_food: isFood,
    prep_time_mins: p.estimatedPrepMins ?? null,
    sold_out_for_today: soldOutForToday,
    allow_preorder: p.allowPreOrder === true,
    // Food modifier groups with options resolved to { name, additionalPrice }
    // (additionalPrice converted from kobo to Naira). Tax is applied to the
    // product price and floor only — mirroring velte's computePrice, which does
    // not tax modifier add-ons.
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
    // Floor is VAT-inclusive too, so the negotiation band is all in the same
    // (tax-inclusive) terms the customer sees.
    min_price: p.minimumPrice ? withVat(p.minimumPrice / 100) : null,
    image_url: toWhatsappSafeImageUrl(p.mainImageUrl),
    gallery: (p.thumbnailUrls || []).map(toWhatsappSafeImageUrl),
    tags: p.tags || [],
    useCases: [],
    attributes: attrGroups,
  };
}

// ─── Bounded LRU cache ──────────────────────────────────────────────────────

// A Map with a hard entry cap and least-recently-used eviction. These caches are
// the only per-process state that can grow without bound (one entry per business
// / query / product image), so each gets a ceiling. TTL still expires stale
// entries on read; the LRU bound caps total memory regardless of how many
// distinct keys are seen over the process's lifetime. Reading or writing a key
// marks it most-recently-used; once over capacity the oldest key is evicted.
// (Single-instance memory guard — a multi-instance deploy would move these to
// Redis instead; see CLAUDE.md.)
class LruCache extends Map {
  constructor(maxSize) {
    super();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value); // re-insert as most-recently-used
    return value;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (this.size > this.maxSize) {
      super.delete(super.keys().next().value); // evict least-recently-used
    }
    return this;
  }
}

// ─── Product cache ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PRODUCT_CACHE_MAX = 200;        // distinct businesses' product lists held
const SEMANTIC_BUSINESS_MAX = 200;    // distinct businesses with cached rankings
const SEMANTIC_QUERY_CACHE_MAX = 100; // cached rankings kept per business
const VISUAL_CACHE_MAX = 2000;        // product-image descriptions (shared)

const productCache = new LruCache(PRODUCT_CACHE_MAX);

export function invalidateProductCache(businessId) {
  productCache.delete(businessId);
  semanticCache.delete(businessId);
}

// Drop every business's cached products and rankings. Used by the change stream
// for delete events, which don't carry the document's vendorId — so we can't
// target a single business and clear all instead (deletes are rare).
export function invalidateAllProductCaches() {
  productCache.clear();
  semanticCache.clear();
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

// Cost gate for the semantic pass (the heaviest call — up to SEMANTIC_MAX_CANDIDATES
// products in the prompt). A bare single-word query already backed by enough
// confident keyword matches skips the model entirely; qualified or low-confidence
// searches still run it (see searchProducts).
const KEYWORD_CONFIDENT_PERCENT = 90;     // matchPercent at/above this = a confident keyword hit
const MIN_CONFIDENT_TO_SKIP_SEMANTIC = 3; // need at least a full card page of them to skip

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

const semanticCache = new LruCache(SEMANTIC_BUSINESS_MAX); // businessId → LruCache(query → { ranking, expiresAt })

function getCachedRanking(businessId, query) {
  const entry = semanticCache.get(businessId)?.get(query);
  return entry && Date.now() < entry.expiresAt ? entry.ranking : null;
}

function setCachedRanking(businessId, query, ranking) {
  if (!semanticCache.has(businessId)) semanticCache.set(businessId, new LruCache(SEMANTIC_QUERY_CACHE_MAX));
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
- "broad": a BARE product type or category with NO narrowing detail and NO audience (e.g. "shoes", "bags", "do you have dresses?"). The shopper hasn't said what they really want yet.
- "specific": it adds any constraint — occasion, use-case, setting, recipient/audience (e.g. for women, for men, for kids, a gift for someone), style, colour, size, material, brand, dietary need, or budget (e.g. "shoes for a wedding", "red size 44 oxfords", "gift for my mum", "snacks for kids", "vegan options", "fashion for women", "ladies shoes"). A recipient/audience is ALWAYS a narrowing detail — treat it as specific even when no product type is named and even when it reads like a department name. In particular "fashion for women", "ladies fashion", "women's clothing", "for women", "for kids" are SPECIFIC (audience-constrained), NEVER broad.

This judgement applies to EVERY kind of business — fashion/retail, food & dishes, drinks, electronics, home goods, AND catering & event services. Reason from what each item or service actually IS, not from its category label. For catering/services, the "type" is the dish or service (small chops, jollof, drinks package, event setup) and the constraints include headcount/guests, event type, date/time, and dietary needs.

How specificity scales — the MORE details the shopper gives, the STRICTER you must be, because each extra detail is another requirement an item must meet to be "strong":
- 0 details → broad: "shoes", "what dishes do you have?", "any drinks?", "what catering do you offer?"
- 1 detail → specific: "red shoes", "vegan dishes", "office bag", "small chops", "drinks for an event"
- 2 details → specific: "red shoes for women", "vegan dishes for kids", "jollof for a party"
- 3+ details → specific (strictest): "red leather oxford shoes for a wedding, size 44", "vegan small chops for 50 guests on Saturday"
At each step up, an item must satisfy ALL the stated details to be "strong"; meeting only some makes it "partial".

Then sort the products using real-world knowledge. Treat the stated details as a CHECKLIST: a product is "strong" ONLY if it satisfies EVERY stated detail. Missing even one drops it to "partial" (or out entirely, if unrelated). Check in this order:

1. PRODUCT TYPE — a hard gate, checked FIRST. If the shopper named a type (clothes, dress, shoes, soup, phone, etc.), the item must actually BE that type. A different type is NEVER "strong", no matter how well it matches everything else. Judge the type from what the item REALLY IS — its name first, and its "visual" field (from its actual photo) when present. Do NOT rely on the vendor's "category" or "tags" labels when they conflict with that, because many shops blanket-tag every item with a department word like "fashion", "clothes", or "clothing" even when the item is shoes or a bag — those labels are unreliable for typing. Reason about real-world categories: "clothes" (also "clothing", "wear", "apparel", "outfit", "fashion") means garments worn on the body — dresses, tops, shirts, trousers, skirts, jackets, gowns. Footwear (shoes, sneakers, trainers, heels, boots, slippers, sandals), bags (handbag, tote, backpack), and other accessories (belts, caps/hats, jewellery, watches, sunglasses) are each their OWN distinct type and are NOT clothes. So for "clothes for men", men's sneakers or a men's bag are the WRONG TYPE → "partial" at most, never "strong" — EVEN IF their category/tags say "fashion", "clothes", or "men". For "soup for kids", a kid-friendly drink is the wrong type → "partial" at most. (Still include items that genuinely fit the type by world knowledge even if their text doesn't say so — a "Chuck Taylor High Top" IS a shoe.)
2. EVERY OTHER STATED DETAIL must also hold — occasion/use (sneakers are not wedding shoes; a hoodie is not office wear), colour, size, material, dietary need (a spicy meat dish is not "vegan" and not "for a toddler"), budget, and audience.
3. AUDIENCE/GENDER (for women / for men / for kids) — strong only if the item genuinely suits that audience. Trust a product's "visual" field (generated from its actual photo) over thin text for style, formality AND gender: a visual that reads women's supports "strong"; one that reads men's or kids' (when they asked for women) is wrong-audience → "partial" or drop. If the audience CANNOT be confirmed from name, category, description, tags, or photo, do NOT assume it fits — "partial", never "strong".

For a BROAD search (a bare type with no details), skip the OTHER details — but the PRODUCT TYPE gate in step 1 STILL applies. Every product OF THE NAMED TYPE is "strong" (the shopper hasn't narrowed within the type, so don't demand occasion/colour/size), but items of a DIFFERENT type are still excluded, never "strong": a bare "clothes" or "fashion" search must still never return footwear, bags, or accessories as "strong".

"partial" = the closest available item that misses one or more stated details — right type but wrong audience/occasion, OR right audience but wrong type. It is NOT a real match, just the nearest thing. Leave a product out of both groups when it is unrelated to the request.

Consequence to internalise: if a shopper asks for "clothes for women" and the shop only stocks a women's handbag and some sneakers, there are ZERO strong matches — those go to "partial" (wrong type), and the reply then honestly says there are no women's clothes right now but offers the closest items, instead of presenting a handbag and sneakers as the clothes they asked for.

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
    // Diagnostic: shows exactly what the ranker decided for this query — the
    // single most useful line for debugging "it showed everything / nothing".
    // specificity=broad means it judged the query a bare type (and marks all
    // type-matches strong); a large `strong` on a query that should be narrow
    // means the catalog lacks the data to tell items apart.
    const visualUsed = catalog.filter((c) => c.visual).length;
    logger.info(
      `[SemanticRank] "${query}" → specificity=${specificity}, strong=${strong.length}, partial=${partial.length} (of ${catalog.length} candidates, ${visualUsed} with photo descriptions)`,
    );
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
const visualCache = new LruCache(VISUAL_CACHE_MAX); // imageUrl → { text, expiresAt }

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
              text: "Describe this product in ONE or TWO factual sentences for search matching. Include, when visible: what the item is; its apparent target audience/gender — women's, men's, unisex, or kids' — judged from styling, cut, shape, and presentation (say \"unisex/unclear\" only when there is genuinely no signal, don't default to it); its style and formality (casual vs formal/dressy); key colour/material; and the occasions or uses it suits. No marketing language.",
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

  // Cost gate: a bare single-word query (a plain product type, e.g. "shoes")
  // already backed by a full page of confident keyword hits doesn't need the
  // semantic re-rank — the keyword results ARE the answer, shown as a broad
  // selection. The model pass is reserved for the cases that need it: qualified
  // queries ("corporate shoes", "shoes for a wedding") that need fit judgment,
  // and sparse/low-confidence keyword results that need recovery or honest
  // "closest match" tiering. This skips the heaviest call on the most common,
  // easiest searches.
  const isSingleWordQuery =
    query.trim().split(/\s+/).filter(Boolean).length === 1;
  const confidentKeywordMatches = keywordMatches.filter(
    (p) => (p.matchPercent ?? 0) >= KEYWORD_CONFIDENT_PERCENT,
  ).length;
  if (isSingleWordQuery && confidentKeywordMatches >= MIN_CONFIDENT_TO_SKIP_SEMANTIC) {
    logger.info(
      `[Search] "${query}" → ${keywordMatches.length} keyword match(es); skipped semantic rank (bare-type query, ${confidentKeywordMatches} confident matches)`,
    );
    return { products: keywordMatches, specificity: 'broad' };
  }

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

/**
 * Compact overview of what the store actually stocks right now — the categories
 * with available stock and how many items are in each. Built from the SAME
 * 5-min-cached product list the search uses (no extra DB query), so it costs
 * nothing per message. Fed to the action-decision model so it can ground its
 * routing (e.g. not claim the store is empty when it isn't) — it is NOT a source
 * of truth for specific items, prices, or stock; those always come from a
 * product action.
 */
export async function getCatalogSummary(businessId) {
  const all = await getProductsForBusiness(businessId);
  const available = all.filter((p) => p.is_available);

  const counts = new Map();
  for (const p of available) {
    const name = String(p.category || '').trim() || 'Other';
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const categories = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { totalAvailable: available.length, categories };
}

/**
 * A compact vocabulary of this store's real product/dish/service names and
 * categories — the proper nouns a speech-to-text model is most likely to
 * mis-hear ("UrbanFlex", "LuxeMini", "jollof", "egusi"). Fed to the voice
 * transcriber as context so it spells them right. Built from the same cached
 * product list (no extra DB query); product names first (most error-prone),
 * then categories, deduped and capped to keep the transcription prompt short.
 */
export async function getCatalogVocabulary(businessId, limit = 40) {
  const all = await getProductsForBusiness(businessId);
  const terms = [];
  const seen = new Set();
  const add = (value) => {
    const t = String(value || '').trim();
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      terms.push(t);
    }
  };

  for (const p of all) add(p.name);       // proper nouns / brands first
  for (const p of all) add(p.category);   // then category labels
  return terms.slice(0, limit);
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
