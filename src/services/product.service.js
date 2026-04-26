import {
  getProductsByBusiness,
  findProductByName,
  formatAttributesForAI,
  getProductCategories as getProductCategoriesFromModel,
} from '../models/Products.js';
import { openai } from '../config/openai.js';

// ─── Search ───────────────────────────────────────────────────────────────────

export function searchProducts(businessId, query) {
  const all = getProductsByBusiness(businessId);
  const q = query.toLowerCase();

  return all.filter((p) => {
    // Match on name or description
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.description.toLowerCase().includes(q)) return true;
    if (p.category.toLowerCase().includes(q)) return true;

    // Also match on attribute values
    // e.g. searching "red" finds products with colors: ['Red', ...]
    // e.g. searching "size 42" finds products with sizes: ['42', ...]
    const attrMatch = Object.values(p.attributes || {}).some((v) =>
      Array.isArray(v)
        ? v.some((item) => String(item).toLowerCase().includes(q))
        : String(v).toLowerCase().includes(q)
    );
    return attrMatch;
  });
}

export function getProductByName(businessId, name) {
  const all = getProductsByBusiness(businessId);
  // Exact match first, then partial
  return (
    all.find((p) => p.name.toLowerCase() === name.toLowerCase()) ||
    findProductByName(businessId, name) ||
    null
  );
}

// ─── Attribute checking ───────────────────────────────────────────────────────

/**
 * Check whether a specific attribute value is available on a product.
 *
 * Examples:
 *   checkAttribute(product, 'sizes', '42')
 *   → { available: true, value: '42', available_options: ['39','40','41','42','43','44'] }
 *
 *   checkAttribute(product, 'colors', 'green')
 *   → { available: false, value: null, available_options: ['Black', 'White'] }
 *
 *   checkAttribute(product, 'sizes', null)   ← user asking "what sizes do you have?"
 *   → { available: true, available_options: ['39','40','41','42','43','44'] }
 */
export function checkAttribute(product, attributeKey, requestedValue) {
  const attrs = product.attributes || {};

  // Case-insensitive key lookup
  const matchedKey = Object.keys(attrs).find(
    (k) => k.toLowerCase() === attributeKey.toLowerCase()
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

  // No specific value requested — just list what's available
  if (!requestedValue) {
    return {
      available: true,
      available_options: optionsList,
    };
  }

  // Check if the requested value exists
  const match = optionsList.find(
    (o) => String(o).toLowerCase() === requestedValue.toLowerCase()
  );

  return {
    available: !!match,
    value: match || null,
    available_options: optionsList,
  };
}

// ─── Context builder for AI ───────────────────────────────────────────────────

/**
 * Build a complete product summary string for the AI system prompt.
 * Includes all attributes so the AI can answer questions without extra API calls.
 */
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
  const all = getProductsByBusiness(businessId);
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


export const getProductCategories = (businessId) => {
  return getProductCategoriesFromModel(businessId);
};