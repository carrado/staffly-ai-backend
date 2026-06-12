/**
 * Product search utilities.
 *
 * Pure, data-agnostic helpers for scoring/formatting products. They operate on
 * a product list supplied by the caller — products always come from the database
 * (see `services/product.service.js`, which loads them via the Mongoose
 * `Product` schema). Nothing here stores or hardcodes any product data.
 */

// Shared term list for food/dish queries — keyed under several trigger words
// below so "food", "menu", "eat", etc. all expand the same way.
const FOOD_TERMS = [
  'food',
  'dish',
  'dishes',
  'meal',
  'meals',
  'menu',
  'eat',
  'lunch',
  'breakfast',
  'dinner',
  'snack',
  'snacks',
  'rice',
  'soup',
  'swallow',
  'drink',
  'drinks',
  'dessert',
];

const SEARCH_SYNONYMS = {
  food: FOOD_TERMS,
  menu: FOOD_TERMS,
  eat: FOOD_TERMS,
  hungry: FOOD_TERMS,
  dish: FOOD_TERMS,
  dishes: FOOD_TERMS,
  meal: FOOD_TERMS,
  meals: FOOD_TERMS,
  kitchen: [
    'kitchen',
    'cooking',
    'cook',
    'cookware',
    'utensil',
    'utensils',
    'food',
    'meal',
    'frying',
    'boiling',
    'blend',
    'blender',
    'pot',
    'pan',
    'knife',
  ],
  fashion: [
    'fashion',
    'style',
    'wear',
    'clothes',
    'clothing',
    'apparel',
    'outfit',
    'shirt',
    'tshirt',
    't-shirt',
    'jacket',
    'shoe',
    'shoes',
    'sneaker',
    'sneakers',
    'bag',
    'bags',
  ],
  shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'footwear'],
  clothes: ['clothes', 'clothing', 'shirt', 'tshirt', 't-shirt', 'jacket', 'wear'],
  bags: ['bag', 'bags', 'tote', 'handbag', 'purse'],
  electronics: ['electronics', 'device', 'gadgets', 'charger', 'speaker', 'phone', 'usb'],
  office: ['office', 'desk', 'study', 'school', 'writing', 'notebook', 'lamp'],
  home: ['home', 'house', 'room', 'lighting', 'cleaning'],
};

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[-_/]/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (value) =>
  normalizeText(value)
    .split(' ')
    .filter(Boolean);

const expandQueryTerms = (query) => {
  const terms = tokenize(query);
  const expanded = new Set(terms);

  for (const term of terms) {
    if (SEARCH_SYNONYMS[term]) {
      SEARCH_SYNONYMS[term].forEach((word) => {
        tokenize(word).forEach((token) => expanded.add(token));
      });
    }
  }

  return Array.from(expanded);
};

export const formatAttributesForAI = (product) => {
  if (!product.attributes || !Object.keys(product.attributes).length) return 'None';

  return Object.entries(product.attributes)
    .map(([key, value]) => {
      const formatted = Array.isArray(value) ? value.join(', ') : value;
      return `${key}: ${formatted}`;
    })
    .join(' | ');
};

const buildSearchIndex = (product) => {
  const nameText = normalizeText(product.name);
  const descriptionText = normalizeText(product.description);
  const categoryText = normalizeText(product.category);
  const tagsText = normalizeText((product.tags || []).join(' '));
  const useCasesText = normalizeText((product.useCases || []).join(' '));
  const attributesText = normalizeText(formatAttributesForAI(product));

  const fullText = [
    nameText,
    descriptionText,
    categoryText,
    tagsText,
    useCasesText,
    attributesText,
  ].join(' ');

  return {
    nameText,
    descriptionText,
    categoryText,
    tagsText,
    useCasesText,
    attributesText,
    fullText,
  };
};

const scoreProductMatch = (product, query) => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  const index = buildSearchIndex(product);
  const queryTerms = expandQueryTerms(normalizedQuery);

  let score = 0;

  if (index.nameText === normalizedQuery) score += 100;
  if (index.nameText.includes(normalizedQuery)) score += 60;
  if (index.descriptionText.includes(normalizedQuery)) score += 45;
  if (index.categoryText.includes(normalizedQuery)) score += 70;
  if (index.tagsText.includes(normalizedQuery)) score += 55;
  if (index.useCasesText.includes(normalizedQuery)) score += 80;
  if (index.attributesText.includes(normalizedQuery)) score += 35;
  if (index.fullText.includes(normalizedQuery)) score += 20;

  for (const term of queryTerms) {
    if (index.nameText.includes(term)) score += 20;
    if (index.descriptionText.includes(term)) score += 16;
    if (index.categoryText.includes(term)) score += 28;
    if (index.tagsText.includes(term)) score += 22;
    if (index.useCasesText.includes(term)) score += 30;
    if (index.attributesText.includes(term)) score += 12;
    if (index.fullText.includes(term)) score += 5;
  }

  return score;
};

export const searchProductsFromList = (products, query, limit = 50) => {
  if (!query || query.trim() === '*') {
    return [...products]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return products
    .map((product) => ({ product, score: scoreProductMatch(product, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.product.name.localeCompare(b.product.name);
    })
    .slice(0, limit)
    .map(({ product }) => product);
};
