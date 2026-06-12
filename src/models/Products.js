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
  chop: FOOD_TERMS, // Pidgin: to eat ("I wan chop rice")
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

// Filler customers type around the actual product ("I wan buy nice shoes for
// men"). These words never identify a product but appear in almost every
// description — left in, they let unrelated items score (e.g. a handbag whose
// copy says "a nice gift for men" matching a shoes search).
const QUERY_STOPWORDS = new Set([
  // English
  'i', 'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'is', 'it',
  'my', 'me', 'you', 'your', 'we', 'our', 'for', 'with', 'this', 'that',
  'these', 'do', 'does', 'have', 'has', 'there', 'some', 'any', 'please',
  'pls', 'want', 'need', 'buy', 'get', 'purchase', 'order', 'find', 'show',
  'see', 'looking', 'look', 'search', 'available', 'sell',
  'nice', 'fine', 'good', 'great', 'best', 'quality', 'original', 'cheap',
  'affordable', 'new',
  // Pidgin
  'wan', 'wetin', 'abeg', 'make', 'una', 'dey', 'na', 'am', 'sef', 'go', 'fit',
]);

// Tokens that can actually identify a product. An all-filler query falls back
// to its raw tokens rather than matching nothing.
const contentTokens = (tokens) => {
  const meaningful = tokens.filter((t) => !QUERY_STOPWORDS.has(t));
  return meaningful.length ? meaningful : tokens;
};

const expandQueryTerms = (query) => {
  const terms = contentTokens(tokenize(query));
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

const scoreProductMatch = (product, query, index = buildSearchIndex(product)) => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

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

/**
 * How closely a product matches the query, as 0–100.
 *
 * Coverage-based: each query token earns a weight by WHERE it (or a synonym)
 * is found — name counts most, category/tags next, description least — and the
 * percentage is the average over all tokens. So "UrbanFlex sneakers" scores
 * ~100 on the actual UrbanFlex pair (every token in the name) but far less on
 * other sneakers (only the generic token matches). A broad one-word query like
 * "sneakers" scores high on everything relevant — which is correct: the whole
 * query is satisfied.
 */
export const computeMatchPercent = (product, query, index = buildSearchIndex(product)) => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  // The whole query appears in the name — can't match better than that.
  if (index.nameText.includes(normalizedQuery)) return 100;

  const tokens = contentTokens(tokenize(normalizedQuery));
  if (!tokens.length) return 0;

  const taxonomyText = [index.categoryText, index.tagsText, index.useCasesText].join(' ');
  const copyText = [index.descriptionText, index.attributesText].join(' ');

  let total = 0;
  for (const token of tokens) {
    const synonyms = (SEARCH_SYNONYMS[token] || [])
      .flatMap((word) => tokenize(word))
      .filter((s) => s !== token);
    const hasSynonym = (text) => synonyms.some((s) => text.includes(s));

    if (index.nameText.includes(token)) total += 1.0;
    else if (hasSynonym(index.nameText)) total += 0.9;
    // A direct category/tag hit IS what the customer asked for — "drinks"
    // matching category "drinks" must reach the strong tier, same as a name hit.
    else if (taxonomyText.includes(token)) total += 0.9;
    else if (hasSynonym(taxonomyText)) total += 0.75;
    else if (copyText.includes(token) || hasSynonym(copyText)) total += 0.6;
  }

  return Math.min(100, Math.round((total / tokens.length) * 100));
};

// Every concrete product word the synonym map knows — used to spot which
// query tokens name a product TYPE ("shoes") vs merely qualify it ("men").
const TYPE_VOCABULARY = new Set(
  Object.values(SEARCH_SYNONYMS)
    .flat()
    .flatMap((word) => tokenize(word)),
);

/**
 * A result must be identified by WHAT it is: a content token (or synonym) in
 * its name, category, tags, or use cases. Description hits still influence
 * ranking, but on their own they no longer admit a product — that's how a
 * handbag whose copy says "nice gift for men" used to surface for a shoes
 * search. And when the query names a product type, only the type token can
 * admit a product: for "men shoes", matching the qualifier "men" must not
 * pull in a men's handbag. Products this gate excludes can still be caught by
 * the semantic AI pass, which judges what an item IS, not what its copy says.
 */
const matchesProductIdentity = (index, normalizedQuery) => {
  const identityText = [
    index.nameText,
    index.categoryText,
    index.tagsText,
    index.useCasesText,
  ].join(' ');

  if (identityText.includes(normalizedQuery)) return true;

  const tokens = contentTokens(tokenize(normalizedQuery));
  const typeTokens = tokens.filter((t) => TYPE_VOCABULARY.has(t));
  const identifying = typeTokens.length ? typeTokens : tokens;

  return identifying.some((token) => {
    if (identityText.includes(token)) return true;
    const synonyms = SEARCH_SYNONYMS[token] || [];
    return synonyms.some((word) =>
      tokenize(word).some((s) => identityText.includes(s)),
    );
  });
};

/**
 * Like searchProductsFromList, but returns [{ product, matchPercent }] so
 * callers can tier results by match strength. Ordered by matchPercent, with
 * the richer relevance score breaking ties.
 */
export const searchProductsFromListScored = (products, query, limit = 50) => {
  if (!query || query.trim() === '*') {
    return [...products]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((product) => ({ product, matchPercent: 100 }));
  }

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return products
    .map((product) => {
      const index = buildSearchIndex(product);
      return {
        product,
        qualifies: matchesProductIdentity(index, normalizedQuery),
        score: scoreProductMatch(product, normalizedQuery, index),
        matchPercent: computeMatchPercent(product, normalizedQuery, index),
      };
    })
    .filter(({ qualifies, score }) => qualifies && score > 0)
    .sort((a, b) => {
      if (b.matchPercent !== a.matchPercent) return b.matchPercent - a.matchPercent;
      if (b.score !== a.score) return b.score - a.score;
      return a.product.name.localeCompare(b.product.name);
    })
    .slice(0, limit)
    .map(({ product, matchPercent }) => ({ product, matchPercent }));
};

export const searchProductsFromList = (products, query, limit = 50) =>
  searchProductsFromListScored(products, query, limit).map(({ product }) => product);
