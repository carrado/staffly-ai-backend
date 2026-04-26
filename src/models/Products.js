/**
 * Products Model — Multi-Tenant
 */

const products = new Map();

const SEARCH_SYNONYMS = {
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

const unique = (items) => [...new Set(items.filter(Boolean))];

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

export const seedDemoProducts = (businessId) => {
  const demo = [
    {
      id: `${businessId}_prod_1`,
      business_id: businessId,
      name: 'Black Sneakers',
      category: 'fashion',
      description: 'Comfortable black sneakers for casual outings, school, work, and everyday walking',
      price: 30000,
      stock: 5,
      allow_negotiation: true,
      min_price: 25500,
      image_url: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800',
      gallery: [],
      tags: ['fashion', 'shoes', 'sneakers', 'footwear', 'casual wear'],
      useCases: ['used for walking', 'used as footwear', 'used for casual fashion'],
      attributes: {
        sizes: ['39', '40', '41', '42', '43', '44'],
        colors: ['Black'],
        material: 'Synthetic leather',
        gender: 'Unisex',
      },
    },
    {
      id: `${businessId}_prod_2`,
      business_id: businessId,
      name: 'Blue Denim Jacket',
      category: 'fashion',
      description: 'Classic blue denim jacket for casual styling and outdoor wear',
      price: 45000,
      stock: 3,
      allow_negotiation: true,
      min_price: 38000,
      image_url: 'https://images.unsplash.com/photo-1601333144130-8cbb312386b6?w=800',
      gallery: [],
      tags: ['fashion', 'clothes', 'jacket', 'denim', 'outerwear'],
      useCases: ['used for fashion', 'used for outdoor wear', 'used as casual clothing'],
      attributes: {
        sizes: ['S', 'M', 'L', 'XL', 'XXL'],
        colors: ['Blue', 'Light Blue'],
        material: '100% Denim',
        gender: 'Unisex',
      },
    },
    {
      id: `${businessId}_prod_3`,
      business_id: businessId,
      name: 'White T-Shirt',
      category: 'fashion',
      description: 'Premium cotton white t-shirt for simple everyday dressing',
      price: 8000,
      stock: 20,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800',
      gallery: [],
      tags: ['fashion', 'clothes', 'shirt', 't-shirt', 'cotton'],
      useCases: ['used for casual wear', 'used as everyday clothing'],
      attributes: {
        sizes: ['XS', 'S', 'M', 'L', 'XL'],
        colors: ['White', 'Black', 'Grey', 'Navy'],
        material: '100% Cotton',
        gender: 'Unisex',
      },
    },
    {
      id: `${businessId}_prod_4`,
      business_id: businessId,
      name: 'Canvas Tote Bag',
      category: 'fashion',
      description: 'Lightweight canvas tote bag for shopping, school, work, and carrying daily items',
      price: 5500,
      stock: 15,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1614119068271-30f8d6a10222?w=800',
      gallery: [],
      tags: ['fashion', 'bag', 'tote', 'shopping bag', 'accessory'],
      useCases: ['used for shopping', 'used for carrying items', 'used as a fashion accessory'],
      attributes: {
        colors: ['Beige', 'Black', 'Olive'],
        material: 'Canvas',
        dimensions: '40cm x 35cm x 10cm',
      },
    },
    {
      id: `${businessId}_prod_5`,
      business_id: businessId,
      name: 'Non-Stick Frying Pan',
      category: 'kitchen',
      description: 'Durable non-stick frying pan for frying eggs, pancakes, fish, and quick meals',
      price: 12000,
      stock: 12,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?w=800',
      gallery: [],
      tags: ['kitchen', 'cooking', 'pan', 'frying pan', 'cookware'],
      useCases: ['used in the kitchen', 'used for cooking', 'used for frying food'],
      attributes: {
        size: '28cm',
        material: 'Aluminium',
        color: 'Black',
      },
    },
    {
      id: `${businessId}_prod_6`,
      business_id: businessId,
      name: 'Stainless Steel Cooking Pot',
      category: 'kitchen',
      description: 'Large stainless steel pot for boiling rice, pasta, soup, stew, and family meals',
      price: 18000,
      stock: 8,
      allow_negotiation: true,
      min_price: 15000,
      image_url: 'https://images.unsplash.com/photo-1584990347449-a732b8317ed2?w=800',
      gallery: [],
      tags: ['kitchen', 'cooking', 'pot', 'cookware', 'boiling'],
      useCases: ['used in the kitchen', 'used for cooking', 'used for boiling food'],
      attributes: {
        capacity: '5L',
        material: 'Stainless steel',
        color: 'Silver',
      },
    },
    {
      id: `${businessId}_prod_7`,
      business_id: businessId,
      name: 'Chef Knife',
      category: 'kitchen',
      description: 'Sharp chef knife for cutting vegetables, meat, fruits, and meal preparation',
      price: 9500,
      stock: 10,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1593618998160-e34014e67546?w=800',
      gallery: [],
      tags: ['kitchen', 'knife', 'cutting', 'utensil', 'meal prep'],
      useCases: ['used in the kitchen', 'used for cutting food', 'used for preparing meals'],
      attributes: {
        blade: 'Stainless steel',
        handle: 'Wooden handle',
      },
    },
    {
      id: `${businessId}_prod_8`,
      business_id: businessId,
      name: 'Electric Blender',
      category: 'kitchen appliances',
      description: 'Powerful blender for smoothies, pepper, tomatoes, soup mix, and food processing',
      price: 35000,
      stock: 6,
      allow_negotiation: true,
      min_price: 30000,
      image_url: 'https://images.unsplash.com/photo-1570222094114-d054a817e56b?w=800',
      gallery: [],
      tags: ['kitchen', 'appliance', 'blender', 'smoothie', 'food processor'],
      useCases: ['used in the kitchen', 'used for blending food', 'used for making smoothies'],
      attributes: {
        power: '500W',
        jar: '1.5L',
        color: 'Black',
      },
    },
    {
      id: `${businessId}_prod_9`,
      business_id: businessId,
      name: 'Wireless Bluetooth Speaker',
      category: 'electronics',
      description: 'Portable Bluetooth speaker for music, parties, room audio, and outdoor sound',
      price: 22000,
      stock: 9,
      allow_negotiation: true,
      min_price: 19000,
      image_url: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800',
      gallery: [],
      tags: ['electronics', 'speaker', 'bluetooth', 'music', 'audio'],
      useCases: ['used for playing music', 'used for parties', 'used for sound'],
      attributes: {
        battery: '10 hours',
        color: 'Black',
        connectivity: 'Bluetooth',
      },
    },
    {
      id: `${businessId}_prod_10`,
      business_id: businessId,
      name: 'USB-C Fast Charger',
      category: 'electronics',
      description: 'Fast USB-C charger for phones, tablets, and compatible devices',
      price: 7500,
      stock: 30,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=800',
      gallery: [],
      tags: ['electronics', 'charger', 'phone accessory', 'usb-c', 'power'],
      useCases: ['used for charging phone', 'used for charging devices'],
      attributes: {
        power: '25W',
        port: 'USB-C',
        color: 'White',
      },
    },
    {
      id: `${businessId}_prod_11`,
      business_id: businessId,
      name: 'Office Desk Lamp',
      category: 'home office',
      description: 'Adjustable LED desk lamp for reading, studying, working, and night lighting',
      price: 14000,
      stock: 11,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800',
      gallery: [],
      tags: ['home', 'office', 'lamp', 'lighting', 'study'],
      useCases: ['used for reading', 'used for studying', 'used on a desk', 'used for lighting'],
      attributes: {
        type: 'LED',
        color: 'White',
        adjustable: true,
      },
    },
    {
      id: `${businessId}_prod_12`,
      business_id: businessId,
      name: 'Notebook Journal',
      category: 'stationery',
      description: 'Hardcover notebook journal for writing notes, school, office, planning, and journaling',
      price: 3500,
      stock: 40,
      allow_negotiation: false,
      min_price: null,
      image_url: 'https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=800',
      gallery: [],
      tags: ['stationery', 'notebook', 'journal', 'writing', 'school', 'office'],
      useCases: ['used for writing', 'used in school', 'used in office', 'used for planning'],
      attributes: {
        pages: '200',
        cover: 'Hardcover',
        color: 'Brown',
      },
    },
  ];

  demo.forEach((product) => products.set(product.id, product));
};

export const addProduct = (productData) => {
  const product = {
    id: `prod_${Date.now()}`,
    attributes: {},
    gallery: [],
    tags: [],
    useCases: [],
    category: '',
    ...productData,
  };

  products.set(product.id, product);
  return product;
};

export const updateProduct = (id, updates) => {
  const existing = products.get(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    attributes: {
      ...existing.attributes,
      ...(updates.attributes || {}),
    },
  };

  products.set(id, updated);
  return updated;
};

export const removeProduct = (id) => products.delete(id);

export const getProductsByBusiness = (businessId) =>
  Array.from(products.values()).filter((product) => product.business_id === businessId);

export const searchProducts = (businessId, query, limit = 50) => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return getProductsByBusiness(businessId)
    .map((product) => ({
      product,
      score: scoreProductMatch(product, normalizedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.product.name.localeCompare(b.product.name);
    })
    .slice(0, limit)
    .map(({ product }) => product);
};

export const findProductByName = (businessId, name) => {
  return searchProducts(businessId, name, 1)[0] || null;
};

export const getProductById = (id) => products.get(id) || null;

export const buildProductContext = (product) => {
  return [
    `Name: ${product.name}`,
    `Category: ${product.category || 'N/A'}`,
    `Description: ${product.description}`,
    `Price: ₦${product.price?.toLocaleString()}`,
    `Stock: ${product.stock}`,
    `Tags: ${(product.tags || []).join(', ') || 'None'}`,
    `Use cases: ${(product.useCases || []).join(', ') || 'None'}`,
    `Attributes: ${formatAttributesForAI(product)}`,
  ].join('\n');
};

export const getProductCategories = (businessId) => {
  const products = getProductsByBusiness(businessId);

  const categories = new Set();

  products.forEach((product) => {
    if (product.category) {
      categories.add(product.category);
    }
  });

  return Array.from(categories);
};