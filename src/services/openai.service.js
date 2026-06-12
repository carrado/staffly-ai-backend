/**
 * OpenAI Service
 *
 * Business-agnostic AI logic. `business` is passed in so the system prompt
 * is personalised per tenant. `session` carries conversation history,
 * last product, and negotiation state — all scoped to that business.
 */

import { openai } from "../config/openai.js";
import { logger } from "../utils/logger.js";
import { buildProductContext } from "../services/product.service.js";
import fs from 'fs';
import { promisify } from 'util';
import { toFile } from "openai/uploads";

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

const VALID_ACTION_TYPES = new Set([
  'none',
  'search_products',
  'show_more_products',
  'check_attribute',
  'start_negotiation',
  'make_offer',
  'accept_offer',
  'find_similar_negotiable',
  'send_product_image',
  'generate_payment_link',
  'list_categories',
]);

const BROAD_SEARCH_KEYWORDS = [
  { terms: ["fashion", "style", "apparel", "outfit"], query: "fashion" },
  { terms: ["clothes", "clothing", "wear"], query: "clothes" },
  {
    terms: ["shoe", "shoes", "sneaker", "sneakers", "footwear"],
    query: "shoes",
  },
  { terms: ["bag", "bags", "tote", "handbag", "purse"], query: "bags" },
  {
    terms: ["shirt", "shirts", "tshirt", "t-shirt", "tee", "top"],
    query: "shirt",
  },
  { terms: ["jacket", "jackets", "coat", "denim"], query: "jacket" },
  {
    terms: ["ladies", "lady", "female", "women", "woman", "girl", "girls"],
    query: "female fashion",
  },
  { terms: ["men", "male", "man", "boys", "boy"], query: "male fashion" },
];


function getAudioExtension(mimeType = "") {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("oga")) return "oga";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("flac")) return "flac";

  return "ogg";
}



function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toCleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value) {
  const cleaned = toCleanString(value);
  return cleaned || null;
}

function parsePossibleNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    // Nigerian shorthand: "20k" = 20,000 and "1.5m" = 1,500,000 — expand the
    // suffix BEFORE stripping non-digits, or "20k" would parse as 20.
    const shorthand = value
      .trim()
      .toLowerCase()
      .match(/^₦?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?$/);
    if (shorthand) {
      const amount = Number(shorthand[1].replace(/,/g, ""));
      const multiplier = shorthand[2] === "k" ? 1000 : shorthand[2] === "m" ? 1e6 : 1;
      if (Number.isFinite(amount) && amount > 0) return amount * multiplier;
    }

    const numericValue = Number(value.replace(/[^\d.]/g, ""));
    // 0 / empty means "no usable amount", not a free product.
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
  }

  return null;
}

/**
 * Nigerian price shorthand drops the thousands: "make I run am 26" on a
 * ₦30,000 product means ₦26,000, not ₦26. When an amount is implausibly small
 * next to the reference price but lands in a believable band once multiplied
 * by 1000, take the scaled reading. Amounts already plausible pass through.
 */
export function scaleOfferToContext(amount, referencePrice) {
  if (!amount || !referencePrice || amount >= referencePrice * 0.05) {
    return amount;
  }
  const scaled = amount * 1000;
  if (scaled >= referencePrice * 0.05 && scaled <= referencePrice * 2) {
    return scaled;
  }
  return amount;
}

/**
 * Pull a plausible price offer out of a raw customer message ("abeg I go pay
 * 20k for am" → 20000). Used as a safety net when the model fails to classify
 * a bid during an active negotiation. Pass the negotiated product's price as
 * `referencePrice` so bare shorthand ("run am 26") resolves to thousands.
 * Amounts under ₦100 after scaling are ignored — they're far likelier to be
 * quantities or times than prices.
 */
export function extractOfferAmount(text, referencePrice = null) {
  const tokens = String(text || "")
    .toLowerCase()
    .match(/₦?\s*\d[\d,]*(?:\.\d+)?\s*[km]?/g);
  if (!tokens) return null;

  const amounts = tokens
    .map((t) => scaleOfferToContext(parsePossibleNumber(t.trim()), referencePrice))
    .filter((n) => n !== null && n >= 100);
  return amounts.length ? Math.max(...amounts) : null;
}

function buildContextString(session) {
  const { lastProduct, negotiation } = session;
  let contextStr = "";

  if (lastProduct) {
    contextStr += `\n--- Last Product Discussed ---\n${buildProductContext(lastProduct)}\n`;
  }

  if (negotiation) {
    // IMPORTANT: never include the minimum/floor price here. It is a hidden
    // figure the customer must never see or be able to infer.
    contextStr += `\n--- Ongoing Negotiation ---\n`;
    contextStr += `Product: ${negotiation.productName}\n`;
    contextStr += `List price: ₦${negotiation.originalPrice?.toLocaleString()}\n`;
    contextStr += `Customer's latest offer: ${
      negotiation.currentOffer
        ? `₦${negotiation.currentOffer.toLocaleString()}`
        : "none yet"
    }\n`;
    contextStr += `Last price you offered: ${
      negotiation.lastCounter
        ? `₦${negotiation.lastCounter.toLocaleString()}`
        : "none yet"
    }\n`;
    contextStr += `Haggling rounds so far: ${negotiation.rounds || 0}\n`;
    contextStr += `Stage: ${negotiation.stage || "unknown"}\n`;
  }

  return contextStr || "No current context.";
}

function normalizeBroadSearchQuery(rawQuery) {
  if (rawQuery?.trim() === '*') return '*';

  const query = normalizeText(rawQuery);
  if (!query) return "";

  for (const rule of BROAD_SEARCH_KEYWORDS) {
    const hasMatch = rule.terms.some((term) => query.includes(term));
    if (hasMatch) {
      return rule.query;
    }
  }

  return toCleanString(rawQuery);
}

function normalizeActionData(type, rawData = {}, session = {}) {
  const data = rawData && typeof rawData === "object" ? { ...rawData } : {};

  switch (type) {
    case "search_products": {
      const rawQuery = toCleanString(data.query);
      return {
        query: normalizeBroadSearchQuery(rawQuery),
      };
    }

    case "check_attribute":
      return {
        productName:
          toNullableString(data.productName) ||
          session.lastProduct?.name ||
          null,
        attributeKey: toNullableString(data.attributeKey),
        requestedValue:
          data.requestedValue === undefined || data.requestedValue === null
            ? null
            : String(data.requestedValue).trim(),
      };

    case "start_negotiation":
      return {
        productName:
          toNullableString(data.productName) ||
          session.lastProduct?.name ||
          null,
      };

    case "make_offer":
      return {
        offer: parsePossibleNumber(data.offer),
      };

    case "accept_offer":
      return {
        finalPrice: parsePossibleNumber(data.finalPrice),
      };

    case "find_similar_negotiable":
      return {
        productName:
          toNullableString(data.productName) ||
          session.lastProduct?.name ||
          null,
      };

    case "send_product_image":
      return {
        productName:
          toNullableString(data.productName) ||
          session.lastProduct?.name ||
          null,
      };

    case "generate_payment_link":
      return {
        productName:
          toNullableString(data.productName) ||
          session.lastProduct?.name ||
          null,
        email: toNullableString(data.email),
        selectedSize: toNullableString(data.selectedSize),
        selectedColor: toNullableString(data.selectedColor),
        selectedModifiers: Array.isArray(data.selectedModifiers)
          ? data.selectedModifiers
              .map((m) => toNullableString(m))
              .filter(Boolean)
          : [],
      };

    case "show_more_products":
      return {};

      case 'list_categories':
        return {};
    case "none":
    default:
      return {};
  }
}

export function normalizeAiOutput(aiOutput, session = {}) {
  const sessionLanguage = session.language === "pidgin" ? "pidgin" : "english";

  const fallback = {
    response:
      sessionLanguage === "pidgin"
        ? "Sorry o, something spoil for my side. Abeg try am again."
        : "I'm sorry, I encountered an error. Please try again.",
    action: { type: "none", data: {} },
    language: sessionLanguage,
  };

  if (!aiOutput || typeof aiOutput !== "object") {
    return fallback;
  }

  // The conversation's language sticks until the model clearly detects a switch.
  const language =
    aiOutput.language === "pidgin" || aiOutput.language === "english"
      ? aiOutput.language
      : sessionLanguage;

  const response =
    typeof aiOutput.response === "string" && aiOutput.response.trim()
      ? aiOutput.response.trim()
      : language === "pidgin"
        ? "I dey here for you — wetin you wan make I do?"
        : "I'm here to help.";

  const rawAction =
    aiOutput.action && typeof aiOutput.action === "object"
      ? aiOutput.action
      : { type: "none", data: {} };

  const type = VALID_ACTION_TYPES.has(rawAction.type) ? rawAction.type : "none";

  // The model sometimes flattens data fields onto the action itself
  // ({"type":"make_offer","offer":20000} instead of {"type":...,"data":{"offer":...}}).
  // Absorb those so a correct decision is never downgraded over its shape.
  const { type: _type, data: rawData, ...flattenedFields } = rawAction;
  const data = normalizeActionData(
    type,
    { ...flattenedFields, ...(rawData && typeof rawData === "object" ? rawData : {}) },
    session,
  );

  if (type === "search_products" && !data.query) {
    return { response, action: { type: "none", data: {} }, language };
  }

  if (type === "check_attribute" && !data.attributeKey) {
    return { response, action: { type: "none", data: {} }, language };
  }

  if (type === "start_negotiation" && !data.productName) {
    return { response, action: { type: "none", data: {} }, language };
  }

  if (type === "make_offer" && data.offer === null) {
    return { response, action: { type: "none", data: {} }, language };
  }

  if (type === "accept_offer" && data.finalPrice === null) {
    return { response, action: { type: "none", data: {} }, language };
  }

  if (type === "generate_payment_link" && !data.productName) {
    return { response, action: { type: "none", data: {} }, language };
  }

  return {
    response,
    action: {
      type,
      data,
    },
    language,
  };
}

function buildActionDecisionPrompt(business, session) {
  const contextStr = buildContextString(session);
  const tone = business.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Your communication style is ${tone}.` : '';

  return `You are an AI sales assistant for "${business.name}".${toneInstruction} You help customers browse products, check sizes/colors/attributes, negotiate prices, and place orders via WhatsApp.

You MUST return ONLY a valid JSON object in this exact structure:
{
  "response": "short natural reply for the customer",
  "language": "english" | "pidgin",
  "action": {
    "type": "none" | "search_products" | "show_more_products" | "check_attribute" | "start_negotiation" | "make_offer" | "accept_offer" | "find_similar_negotiable" | "send_product_image" | "generate_payment_link" | "list_categories",
    "data": {}
  }
}

Language:
- Detect the language of the customer's LATEST message: set "language" to "pidgin" when they write in Nigerian Pidgin, otherwise "english".
- Short or ambiguous replies ("ok", "yes", a number) keep the conversation's previous language. Previous language: ${session.language || "english"}.
- Write "response" in that language. Nigerian Pidgin must sound warm and natural — the way Nigerians actually chat on WhatsApp — never an exaggerated caricature. Keep product names, prices (₦), and links exactly as they are.

Nigerian Pidgin comprehension (CRITICAL — many customers shop entirely in Pidgin; misreading them loses sales):
- Price offers come in MANY phrasings. ALL of these are make_offer, never "none":
  - "make I run am 26" / "I go run am 26" / "run am for 26" = "I'll pay 26" → make_offer
  - "I fit do 25k" / "I go do 25" / "make we do am 25" → make_offer
  - "make we close am for 20k" / "collect 20k" / "take 20k" / "oya collect 22" → make_offer
  - "na 25 I get" / "na 25k I fit afford" / "na wetin I fit afford be that" (after a number) → make_offer
  - "25 last" / "I no fit pass 25" / "abeg manage 25k" → make_offer
- Discount requests WITHOUT a number are start_negotiation:
  - "how much last?" / "last price?" / "wetin be your last?" / "you go fit reduce am?" / "e too cost" / "price dey too high" / "abeg do am for me" / "help me na"
- Buying intent → generate_payment_link: "I go carry am" / "package am for me" / "oya make we do am" (after a price is settled) / "I don gree" / "send me link make I pay".
- Browsing → search_products: "wetin you get?" / "wetin dey?" / "make I see wetin you dey sell" (query "*"); "I wan chop" / "belle dey hungry me" (food, query "*"); "you get shoe?" (query "shoes").
- Filler words carry no intent on their own: "oya" (alright), "abeg" (please), "sha", "o", "na", "sef", "shey/abi" (right?), "no wahala" (no problem). NEVER let filler distract from a number or intent in the same message.
- Money shorthand (any language): customers drop the thousands — "26" usually means ₦26,000. Resolve bare numbers against the price context: if the product costs ₦30,000 and they say "make I run am 26", the offer is 26000, NOT 26. "26k" = 26000, "1.2m" = 1200000. Always put the RESOLVED full Naira amount in data.offer.

Rules:
- You MUST choose exactly one action.type from the allowed list.
- Never invent a new action type.
- CRITICAL: NEVER state, hint at, or imply any minimum price, price floor, "lowest we can go", or how much room there is to discount. That figure is secret. You may only ever mention the list price or a specific price you are offering right now.
- CRITICAL: NEVER claim, invent, or imply that a product, size, color, price, or stock level exists. The catalog lives in the database. Whenever the customer asks about products, availability, attributes, pricing, or images, you MUST choose the matching product action (search_products, check_attribute, send_product_image, etc.) so real data is fetched — do not answer about products from memory and do not assume the store has something.
- Prefer a business action over "none" when the customer is asking about products, attributes, pricing, negotiation, or payment.
- Use "check_attribute" when the customer asks about size, color, material, fit, stock variant, capacity, dimensions, or any specific product attribute.
- Use "generate_payment_link" when the customer wants to buy, order, pay, checkout, or proceed with purchase.
- Food items may have modifier groups (e.g. choice of protein, toppings) listed as "Modifier" lines in the product context, each option with its extra cost. When the customer has told you their choices, pass the exact option names in data.selectedModifiers. If they order a dish without picking from a required group, still choose generate_payment_link — the system will tell you which choices are missing so you can ask.
- Use "start_negotiation" when the customer asks for a discount, better price, "last price", reduction, or to negotiate, but has NOT yet named a specific amount.
- Use "make_offer" when the customer proposes a specific price (e.g. "I fit pay 20k", "can you do 18000?", "20k last", "make I run am 26", "oya collect 22"), whether or not a negotiation is already active. Put the amount in "offer" as a plain number in Naira, resolving shorthand against the price context (e.g. "20k" → 20000; "26" → 26000 when the product costs tens of thousands).
- NEVER stall on a price offer. Do not write that you will "check", "confirm", "see if e fit work", "get back to them", or consider it — pricing is resolved INSTANTLY by the system. Choose "make_offer" and the system hands you the decision (a counter-price, an acceptance, or a final price) to deliver in the same reply.
- Use "accept_offer" only when the customer clearly agrees to the price YOU last offered (e.g. "ok", "deal", "that's fine", "I'll take it").
- Use "find_similar_negotiable" when the customer agrees to see similar or alternative products after you offered to find items they can negotiate on (e.g. they reply "yes", "sure", "show me"), or when they directly ask for similar items they can bargain on.
- Use "send_product_image" when the customer wants to SEE a product — its picture, photo, image, what it looks like, or to see a product together with its details (e.g. "send me the picture", "can I see it?", "show me a photo and details", "what does it look like?", "any images?"). This is the ONLY way to send a photo.
- Use "none" only for pure greetings, thanks, or casual conversation with absolutely no product interest.
- If the customer says "it", "that one", or similar, use the last product from context.
- Use "show_more_products" when the customer says "show more", "see more", "next", "more products", "can I see more", "can you show me the rest" or wants to continue the previous product search.
- Use "list_categories" ONLY when the customer explicitly asks for category or department names, e.g. "what categories do you have?", "list your categories", "what departments do you have?".

CRITICAL — product browsing detection:
- Use "search_products" for ANY message where the customer wants to SEE or BROWSE products.
- Use { "query": "*" } to show ALL products for these broad requests (and similar ones):
  - "What do you have?" / "What do you sell?" / "What is available?"
  - "Show me your products" / "Show me what you have" / "Show me everything"
  - "Do you have products?" / "What's in your store?" / "I want to see your items"
  - "Let me see your products" / "What can I buy?" / "Browse products"
- Use a specific query for category or type requests:
  - "show me fashion items" → { "query": "fashion" }
  - "what clothes do you have?" → { "query": "clothes" }
  - "do you have bags?" → { "query": "bags" }
  - "show me shoes" → { "query": "shoes" }
  - "I wan buy nice shoes for men" → { "query": "men shoes" } (keep only the product type, brand, and real qualifiers like color/gender/size — drop filler such as "I want to buy", "nice", "fine", "abeg")
  - "anything for ladies?" → { "query": "female fashion" }
  - "what do you have for men?" → { "query": "male fashion" }
  - "something used in the kitchen" → { "query": "kitchen" }
- Food businesses work the same way — dishes, meals, and drinks are products:
  - "what's on the menu?" / "what can I eat?" / "I'm hungry" → { "query": "*" }
  - "do you have jollof rice?" → { "query": "jollof rice" }
  - "any soups?" → { "query": "soup" }
  - "what drinks do you have?" → { "query": "drinks" }
- search_products applies to product names, categories, descriptions, use cases, and any product-related phrase.
- Keep responses concise and WhatsApp-friendly.

Action data rules:
- search_products → { "query": "* for all products, or a specific category/type/name" }
- check_attribute → {
    "productName": "product name or null if last product should be used",
    "attributeKey": "sizes | colors | material | stock | dimensions | etc",
    "requestedValue": "specific value or null"
  }
- start_negotiation → { "productName": "product name or null if last product should be used" }
- make_offer → { "offer": 25000 }
- accept_offer → { "finalPrice": 25000 }
- find_similar_negotiable → { "productName": "the product they were looking at, or null to use the last product" }
- send_product_image → { "productName": "product name or null to use the last product" }
- generate_payment_link → {
    "productName": "exact product name or null if last product should be used",
    "email": "customer email if provided or null",
    "selectedSize": "chosen size if provided or null",
    "selectedColor": "chosen color if provided or null",
    "selectedModifiers": ["exact modifier option names the customer chose, e.g. [\"Chicken\", \"Extra Plantain\"], or [] if none"]
  }
- show_more_products → {}
- list_categories → {}
- none → {}

Current context:
${contextStr}`;
}

function buildActionResultPrompt(business, session, actionResult) {
  const contextStr = buildContextString(session);
  const tone = business.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Your communication style is ${tone}.` : '';

  return `You are an AI sales assistant for "${business.name}".${toneInstruction}
You just executed an action for a customer. Use the action result below to craft a natural, helpful WhatsApp reply.

Current context:
${contextStr}

Action result:
${JSON.stringify(actionResult, null, 2)}

Guidelines:
- LANGUAGE: ${
    session.language === "pidgin"
      ? "The customer chats in Nigerian Pidgin — EVERY sentence of your reply, including any opening and closing line, must be in warm, natural Nigerian Pidgin (the way Nigerians actually chat on WhatsApp, never an exaggerated caricature). Do not slip back into standard English anywhere."
      : "Mirror the customer's language: if their messages are in Nigerian Pidgin, reply in warm, natural Nigerian Pidgin; otherwise reply in clear, friendly English."
  } Keep product names, prices (₦), and links exactly as given.
- HONESTY (most important): Only ever mention products, prices, sizes, colors, images, or stock that ACTUALLY appear in the action result or context above. Never invent, assume, or imply that the store has something. The catalog is the database — if it isn't in the result, it doesn't exist for you.
- For product search results:
  - If actionResult.count === 0 (or products is empty): clearly and politely tell the customer you don't currently have any product matching that. Do NOT pretend a match exists or describe an imaginary item. Offer to show available categories or ask them to describe what else they need.
  - actionResult.matchTier tells you how well the shown products fit the search:
    - "strong": they are what the customer asked for — present them confidently.
    - "partial": nothing closely matched the exact request — be upfront that you don't have exactly that, then present these as the closest items they might like instead. Never pass a partial match off as the exact product they named.
    - Never mention match percentages, scores, or tiers to the customer.
  - If displayMode is "text" (or absent): list ONLY the products in actionResult.products as a numbered list, one entry per product, numbering from actionResult.startNumber (default 1). Each entry MUST follow EXACTLY this format:
    1. *Product Name* - Short one-line description. Price: ₦18,000. Available in red, black, white, and blue, with sizes 39, 41, and 42.
    Build the "Available in ..." sentence from the product's actual attributes (colors, sizes, etc.); omit it when the product has no attributes. Use each product's real description, shortened to one line. Do not add anything else per entry.
    For food/dish items (isFood true): mention the prep time when present instead of sizes/colors, e.g. "1. *Jollof Rice with Chicken* - Smoky party-style jollof served with grilled chicken. Price: ₦4,500. Ready in ~25 mins." If soldOutForToday is true, end the entry with "(sold out for today)".
  - NEVER mention remaining items, extra items, or more products, and never invite the customer to reply "show more" — when more items actually exist, the system automatically appends that note for you. List or introduce ONLY what is in actionResult.products.
  - For any product where inStock is false (or stock is 0), say it is currently out of stock — do not present it as available to buy. For food items where soldOutForToday is true: if allowPreOrder is true, offer it as a pre-order; otherwise say it is sold out for today and suggest they check back tomorrow.
  - When a customer asks how long their food will take, use the product's prepTimeMins.
  - Keep it short and scannable.
- For attribute checks:
  - If available, confirm clearly.
  - If unavailable, say so and list available options if present.
  - Never confirm a size/color/variant that is not in the result.
- For product image requests: a product card with the photo (when available) and the FULL details is being sent to the customer right now. Write only a short, friendly one-line note to go with it (e.g. "Here's the {product} 👇"). Do NOT re-list the details and do not claim to attach anything else.
  - If hasImage is false, briefly mention a photo isn't available for it, but its full details are shown.
- For payment links: confirm product, selected options, price, and share the link naturally. If the result includes selectedModifiers, confirm those choices as part of the order (the price already includes their extra cost).
- If the result has "needsModifiers": true, the order was NOT placed and no payment link exists yet. Ask the customer to choose from each group in missingGroups, listing every option with its extra cost when it has one (e.g. "Chicken +₦500, Beef +₦800"). Do not invent options and do not share any link.
- For price negotiation (the action result has a "negotiation" object):
  - SECRECY (non-negotiable rule): while bargaining, never reveal, hint at, or imply a minimum price, floor, or how low you can go. Only ever mention the list price or the exact price you are offering now. The ONLY exception is outcome "final" below — and even then, present negotiation.finalPrice simply as your final price, never as a "minimum", "floor", or "the lowest we're allowed to go".
  - PRICES ONLY MOVE DOWN: never state a counter or final price HIGHER than any price you already offered this customer for this product earlier in the conversation. The price in the action result is the standing commitment — quote exactly that number, and never resurrect an older, higher number from the chat history.
  - outcome "started": warmly invite the customer to make an offer. Do NOT name a discounted price yourself.
  - outcome "counter": you are countering at negotiation.counterPrice. Your reply MUST state that exact price (₦ formatted) as the price you are offering RIGHT NOW — never say you will check, confirm, or get back to the customer; the decision is already made. Present it as YOUR price and justify the number using the REAL qualities of this product from the "product" details — quality, material, features, popularity, and limited availability if product.lowStock is true. Be warm but hold the value; do not cave to the customer's number and do not mention any minimum. Style examples (do NOT copy them word-for-word; write your own in the same spirit): English — "Because of the quality on this one, the best I can do right now is ₦X."; Pidgin — "This one na original o — make we meet for ₦X, you no go regret am."
  - outcome "accept": the deal is agreed at negotiation.acceptedPrice. Confirm it enthusiastically and move the customer to payment using the link in the result.
  - outcome "final": negotiation.finalPrice is your FINAL price — the haggling is over. State it clearly and warmly: this is the last price, there is no reduction after this. Do not apologise excessively and do not invite further offers on this product. If it's beyond their budget, offer to show similar items they can negotiate on. Style examples (do NOT copy them word-for-word; write your own in the same spirit, and never write "Oga/Madam" literally — address the customer naturally or not at all): English — "I've stretched as far as I can — ₦X is my final price on this one. Should I package it for you?"; Pidgin — "Last price na ₦X — I no fit go lower pass that one at all. Make I package am for you?"
- For fixed-price products (action result has "nonNegotiable": true):
  - Politely explain that the price for this product is fixed and you can't reduce it. Do not haggle.
  - Then offer to find similar products they CAN negotiate on, and ask if they'd like to see them.
- For similar product suggestions (action result has "similar": true):
  - Introduce them as alternatives the customer can negotiate on.
  - List ONLY the products in actionResult.products: name, price, and one short reason each fits. Plain text only — no images.
  - Do not mention remaining items or "show more" — the system appends that note automatically when more exist.
  - If count === 0, say you couldn't find similar negotiable items right now and offer to help another way.
- If the result has "storeHandoff": true: the customer has already seen everything you can show in chat, but moreProductsCount more products are still available. Warmly and politely let them know the full catalog is on the store's website where they can browse and buy everything, and include storeLink EXACTLY as written — do not alter, shorten, or invent the URL. Do not list or describe any further products, and do not mention "show more".
- For category listing:
  - If there are categories in the result, mention them clearly and conversationally. Do NOT list individual product names.
  - If the categories list is empty (no products), honestly tell the customer the store has no products available yet — do not invent categories or products.
- If there is an error, explain it clearly and guide the customer on the next step.
- Plain text only. NEVER use markdown link syntax like [text](url) — WhatsApp does not render it; always write URLs bare.
- No JSON.
- Keep it concise for WhatsApp.${
    session.language === "pidgin"
      ? "\n\nFINAL REMINDER: every single sentence of the reply — opening, list intro, and closing line included — must be in Nigerian Pidgin. No standard-English sentence anywhere."
      : ""
  }`;
}

/**
 * First AI call: given the user's message and session context, decide what
 * action to take and draft an initial response.
 *
 * Returns: { response: string, action: { type: string, data: object } }
 */
export async function processMessage(userMessage, session = {}, business) {
  const conversationHistory = Array.isArray(session.conversationHistory)
    ? session.conversationHistory
    : [];

  const messages = [
    { role: "system", content: buildActionDecisionPrompt(business, session) },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const rawContent = completion.choices?.[0]?.message?.content || "{}";
    const parsed = safeJsonParse(rawContent);

    if (!parsed) {
      logger.warn(`processMessage returned invalid JSON: ${rawContent}`);
      return {
        response: "I'm sorry, I encountered an error. Please try again.",
        action: { type: "none", data: {} },
      };
    }

    return parsed;
  } catch (error) {
    logger.error("processMessage failed:", error);
    return {
      response: "I'm sorry, I encountered an error. Please try again.",
      action: { type: "none", data: {} },
    };
  }
}

/**
 * Second AI call: after we've executed an action (e.g. searched products,
 * checked a size), craft a natural WhatsApp-friendly response using the result.
 *
 * Returns: { response: string }
 */
export async function generateResponseWithActionResult(
  userMessage,
  session = {},
  actionResult,
  business,
) {
  const conversationHistory = Array.isArray(session.conversationHistory)
    ? session.conversationHistory
    : [];

  const messages = [
    {
      role: "system",
      content: buildActionResultPrompt(business, session, actionResult),
    },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4,
    });

    return {
      response:
        completion.choices?.[0]?.message?.content?.trim() ||
        "I'm sorry, I encountered an error while processing your request.",
    };
  } catch (error) {
    logger.error("generateResponseWithActionResult failed:", error);
    return {
      response:
        "I'm sorry, I encountered an error while processing your request.",
    };
  }
}

// ─── Pidgin product descriptions ──────────────────────────────────────────────

// Vendor descriptions are written in English; Pidgin sessions get them
// translated so product cards match the conversation. Cached per product —
// the key includes the text itself, so an edited description re-translates.
const pidginDescriptionCache = new Map(); // `${id}:${description}` → { text, expiresAt }
const PIDGIN_DESC_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Return copies of `products` with descriptions translated to Nigerian
 * Pidgin. One batched model call per send covers every uncached product;
 * any failure leaves the original English description in place.
 */
export async function translateDescriptionsToPidgin(products) {
  const translated = new Map(); // product id → pidgin description
  const pending = [];

  for (const product of products) {
    const description = (product.description || '').trim();
    if (!description) continue;

    const cacheKey = `${product.id}:${description}`;
    const hit = pidginDescriptionCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      translated.set(product.id, hit.text);
    } else {
      pending.push({ id: product.id, description });
    }
  }

  if (pending.length) {
    const prompt = `Translate each product description below into warm, natural Nigerian Pidgin — the way Nigerians actually chat on WhatsApp, never an exaggerated caricature. Keep product names, brand names, numbers, and prices exactly as they are, and keep each translation about the same length as the original.

Respond with JSON: {"translations": {"<id>": "<pidgin description>"}} — one entry per item, using the exact ids given.

Items:
${JSON.stringify(pending)}`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const parsed = safeJsonParse(completion.choices?.[0]?.message?.content || '{}');
      const translations = parsed?.translations || {};

      for (const { id, description } of pending) {
        const text = toCleanString(translations[id]);
        if (!text) continue; // missing/empty → that card stays English
        translated.set(id, text);
        pidginDescriptionCache.set(`${id}:${description}`, {
          text,
          expiresAt: Date.now() + PIDGIN_DESC_CACHE_TTL_MS,
        });
      }
    } catch (error) {
      logger.warn(
        `[Pidgin] Description translation failed (cards stay in English): ${error.message}`,
      );
    }
  }

  return products.map((p) =>
    translated.has(p.id) ? { ...p, description: translated.get(p.id) } : p,
  );
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

export async function transcribeAudio(audioData) {
  const buffer = Buffer.isBuffer(audioData) ? audioData : audioData.buffer;
  const mimeType = Buffer.isBuffer(audioData)
    ? "audio/ogg"
    : audioData.mimeType || "audio/ogg";

  const extension = getAudioExtension(mimeType);

  const file = await toFile(buffer, `voice-note.${extension}`, {
    type: mimeType,
  });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });

  return transcription.text;
}

export async function generateGreeting(type, business, language = 'english') {
  const tone = business.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Your communication style is ${tone}.` : '';
  const languageInstruction =
    language === 'pidgin'
      ? ' The customer chats in Nigerian Pidgin — write in warm, natural Nigerian Pidgin.'
      : '';

  // The configured greeting is only ever a fallback for first visits — a
  // "welcome back" must never reuse it.
  const fallback =
    type === 'first_visit'
      ? business.aiConfig?.greetingMessage?.trim() || `Welcome to ${business.name}! 👋 How can I help you today?`
      : `Welcome back to ${business.name}! 👋 How can I help you today?`;

  try {
    const userPrompt =
      type === 'first_visit'
        ? `Write a warm, engaging welcome message for a brand-new customer chatting with us for the first time. Keep it short and WhatsApp-friendly. Plain text only, no JSON, no markdown.`
        : `Write a very short, warm "welcome back" message for a returning customer who was away for a while. Make it feel personal and inviting. Plain text only, no JSON, no markdown.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an AI sales assistant for "${business.name}".${toneInstruction}${languageInstruction}`,
        },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
    });

    return completion.choices?.[0]?.message?.content?.trim() || fallback;
  } catch (error) {
    logger.error('generateGreeting failed:', error);
    return fallback;
  }
}

export async function generateVoiceErrorMessage(business, language = "english") {
  const fallback =
    language === "pidgin"
      ? "Sorry o, I no fit process your voice note. Abeg type your message as text 🙏"
      : "Sorry, I couldn't process your voice note. Please send your message as text 🙏";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful AI assistant for "${business.name}".${
            language === "pidgin"
              ? " The customer chats in Nigerian Pidgin — write in warm, natural Nigerian Pidgin."
              : ""
          }`,
        },
        {
          role: "user",
          content:
            "A user sent a voice note but it failed to process. Politely ask them to send a text message instead. Keep it short, friendly, and conversational like WhatsApp.",
        },
      ],
      temperature: 0.5,
    });

    return completion.choices?.[0]?.message?.content?.trim() || fallback;
  } catch (error) {
    logger.error("Voice fallback AI failed:", error);

    return fallback;
  }
}

export async function textToSpeech(text) {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
  });

  return Buffer.from(await mp3.arrayBuffer());
}
