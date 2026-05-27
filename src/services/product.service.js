import {
  getProductsByBusiness as getInMemoryProducts,
  findProductByName,
  searchProductsFromList,
  formatAttributesForAI,
  getProductCategories as getInMemoryCategories,
} from '../models/Products.js';
import { getBusinessById } from '../models/Business.js';
import { Product } from '../models/mongoose/Product.js';
import { openai } from '../config/openai.js';

// ─── Shape conversion ─────────────────────────────────────────────────────────

function toStafflyProduct(p) {
  // Velte stores attributes as [{ name, value }] pairs.
  // Group them into { Size: ['S','M','L'], Color: ['Black'] } for compatibility.
  const attrGroups = {};
  for (const attr of p.attributes || []) {
    if (!attrGroups[attr.name]) attrGroups[attr.name] = [];
    attrGroups[attr.name].push(attr.value);
  }

  return {
    id: p._id.toString(),
    business_id: p.vendorId?.toString() || '',
    name: p.name,
    category: p.categoryId || '',
    description: p.description || '',
    price: p.discountedPrice || p.price || 0,
    stock: p.stockQuantity ?? (p.isCurrentlyAvailable !== false ? 999 : 0),
    allow_negotiation: p.isNegotiable || false,
    min_price: p.minimumPrice || null,
    image_url: p.mainImageUrl || '',
    gallery: p.thumbnailUrls || [],
    tags: p.tags || [],
    useCases: [],
    attributes: attrGroups,
  };
}

// ─── Data source ──────────────────────────────────────────────────────────────

async function getProductsForBusiness(businessId) {
  const business = getBusinessById(businessId);
  if (!business) return [];

  // Real business: query MongoDB by vendorId
  if (business.velteUserId) {
    const docs = await Product.find({ vendorId: business.velteUserId }).lean();
    return docs.map(toStafflyProduct);
  }

  // Test / dev business: fall back to in-memory demo products
  return getInMemoryProducts(businessId);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchProducts(businessId, query, limit = 50) {
  const all = await getProductsForBusiness(businessId);
  return searchProductsFromList(all, query, limit);
}

export async function getProductsByIds(ids) {
  if (!ids?.length) return [];

  // Try MongoDB first (real products have ObjectId-style ids)
  try {
    const docs = await Product.find({ _id: { $in: ids } }).lean();
    if (docs.length) return docs.map(toStafflyProduct);
  } catch {
    // ids may be in-memory string format — fall through
  }

  // Fallback: look up from in-memory map one by one
  const { getProductById: getInMemoryById } = await import('../models/Products.js');
  return ids.map(getInMemoryById).filter(Boolean);
}

export async function getProductById(id) {
  // Try MongoDB
  try {
    const doc = await Product.findById(id).lean();
    if (doc) return toStafflyProduct(doc);
  } catch {
    // Not a valid ObjectId — in-memory product
  }

  const { getProductById: getInMemoryById } = await import('../models/Products.js');
  return getInMemoryById(id) || null;
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
  if (!business) return [];

  if (business.velteUserId) {
    const docs = await Product.find({ vendorId: business.velteUserId }, { categoryId: 1 }).lean();
    return [...new Set(docs.map((d) => d.categoryId).filter(Boolean))];
  }

  return getInMemoryCategories(businessId);
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
  return [
    `Name: ${product.name}`,
    `Description: ${product.description}`,
    `Price: ₦${product.price.toLocaleString()}`,
    `Stock: ${product.stock}`,
    `Negotiable: ${product.allow_negotiation}${product.min_price ? ` (min: ₦${product.min_price.toLocaleString()})` : ''}`,
    `Attributes: ${formatAttributesForAI(product)}`,
  ].join('\n');
}

// ─── AI-powered suggestions ───────────────────────────────────────────────────

export async function suggestProducts(businessId, userDescription) {
  const all = await getProductsForBusiness(businessId);
  if (!all.length) return [];

  const productList = all
    .map((p) => `${p.name}: ${p.description} [${formatAttributesForAI(p)}]`)
    .join('\n');

  const prompt = `Based on the user's interest: "${userDescription}", suggest the best matching products from this list. Return product names as a JSON array under the key "suggestions".\n\nAvailable products:\n${productList}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  const result = JSON.parse(completion.choices[0].message.content);
  const names = result.suggestions || [];
  return all.filter((p) => names.includes(p.name));
}
