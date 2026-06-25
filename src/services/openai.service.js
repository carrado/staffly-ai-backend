/**
 * OpenAI Service
 *
 * Business-agnostic AI logic. `business` is passed in so the system prompt
 * is personalised per tenant. `session` carries conversation history,
 * last product, and negotiation state — all scoped to that business.
 */

import { openai } from "../config/openai.js";
import { anthropic } from "../config/anthropic.js";
import { logger } from "../utils/logger.js";
import { buildProductContext, getCatalogSummary, getCatalogVocabulary } from "../services/product.service.js";
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

// Each rule collapses a BARE, generic browse to a canonical broad query the
// semantic ranker handles well. `broad` lists ONLY the words that genuinely mean
// "just this broad type" — synonyms and plain plurals. Narrower SUBTYPES
// (handbag, sneaker, tote, purse) are deliberately excluded: a shopper asking
// for "handbags" or "sneakers" wants that specific kind, not the whole category,
// so those queries pass through untouched for the ranker to judge.
const BROAD_SEARCH_KEYWORDS = [
  { broad: ["fashion", "style", "apparel", "outfit"], query: "fashion" },
  { broad: ["clothes", "clothing", "wear"], query: "clothes" },
  { broad: ["shoe", "shoes", "footwear"], query: "shoes" },
  { broad: ["bag", "bags"], query: "bags" },
  { broad: ["shirt", "shirts", "tshirt", "t-shirt", "tee"], query: "shirt" },
  { broad: ["jacket", "jackets", "coat"], query: "jacket" },
];

// Audience/recipient words. These are a RECIPIENT CONSTRAINT, not a product
// category — handled separately (see reframeAudienceQuery) because the
// classifier often pairs them with a type word ("ladies fashion", "shoes for
// men"), which the bare-type rules above can't catch. Whenever an audience word
// appears anywhere in the query, we rewrite it as "<type> for <audience>" (or
// just "for <audience>" if no type was named) so the ranker reads the audience
// as a narrowing constraint and judges fit — instead of reading "ladies
// fashion" as a department name and showing the whole catalog. Product-neutral:
// works for fashion, food, electronics, anything.
const AUDIENCE_TERMS = [
  { terms: ["women", "woman", "ladies", "lady", "female", "females", "girl", "girls", "womens"], label: "women" },
  { terms: ["men", "man", "male", "males", "boys", "boy", "mens", "gentlemen"], label: "men" },
  { terms: ["kids", "kid", "children", "child", "baby", "babies", "toddler", "toddlers", "infant"], label: "kids" },
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

// A whole-number unit quantity (≥1), or null when not a usable number.
function toPositiveInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// The buyer/order details any checkout action may carry. Shared by
// generate_payment_link, accept_offer, and make_offer so a customer can supply
// them at any point (e.g. alongside an offer, or in a later reply) and the
// controller accumulates them until the order has everything it needs.
function extractCheckoutData(data = {}) {
  return {
    email: toNullableString(data.email),
    customerName: toNullableString(data.customerName),
    location: toNullableString(data.location),
    // How many units the customer wants (null = not stated → defaults to 1).
    quantity: toPositiveInt(data.quantity),
    selectedSize: toNullableString(data.selectedSize),
    selectedColor: toNullableString(data.selectedColor),
    // Generic variant picks for ANY product attribute the customer chose
    // (Storage, Material, Flavour, …), each a { name, value } pair.
    selectedAttributes: Array.isArray(data.selectedAttributes)
      ? data.selectedAttributes
          .map((a) => ({
            name: toNullableString(a?.name),
            value: toNullableString(a?.value),
          }))
          .filter((a) => a.name && a.value)
      : [],
    selectedModifiers: Array.isArray(data.selectedModifiers)
      ? data.selectedModifiers.map((m) => toNullableString(m)).filter(Boolean)
      : [],
  };
}

// Languages flow through the system as free-form lowercase names (english,
// pidgin, yoruba, hausa, french, swahili, …) rather than a fixed enum, so new
// languages need no code change. Normalize casing/spacing and fold the common
// aliases for Nigerian Pidgin so it stays one canonical value.
function normalizeLanguageName(value) {
  const cleaned = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (/\bpidgin\b/.test(cleaned) || cleaned === "naija") return "pidgin";
  return cleaned;
}

// Shared snippet appended to the system prompts of the small AI-composed helpers
// (greetings, payment follow-ups, voice-error notes) so they answer in the
// session's language.
function languageWritingInstruction(language) {
  const lang = normalizeLanguageName(language);
  if (!lang || lang === "english") return "";
  if (lang === "pidgin")
    return " The customer chats in Nigerian Pidgin — write in warm, natural Nigerian Pidgin.";
  return ` The customer chats in ${lang} — write your reply in warm, natural ${lang}, the way people actually chat on WhatsApp.`;
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

// Filler words that never narrow a search — mirror the product-search stopwords
// so "do you have any nice products for ladies?" still reduces to the bare
// browse word "ladies". Includes generic nouns ("product", "something") that add
// no product type of their own, so a gender/type word left beside them still
// counts as a bare browse.
const BROAD_QUERY_FILLER = new Set([
  "i", "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "is", "it",
  "my", "me", "you", "your", "we", "our", "for", "with", "this", "that", "these",
  "do", "does", "have", "has", "there", "some", "any", "please", "pls", "want",
  "need", "buy", "get", "purchase", "order", "find", "show", "see", "looking",
  "look", "search", "available", "sell", "nice", "fine", "good", "great", "best",
  "quality", "original", "cheap", "affordable", "new",
  "product", "products", "item", "items", "something", "anything", "stuff",
  "thing", "things", "one", "ones",
  "wan", "wetin", "abeg", "make", "una", "dey", "na", "am", "sef", "go", "fit",
]);

// Collapse a query to a canonical broad term ONLY when it is a bare product
// type with no narrowing qualifier — so "shoes" / "do you have bags?" become a
// broad browse, but "corporate shoes", "shoes for a wedding", or "handbags"
// keep their full text. Flattening those (the old behaviour: any query merely
// CONTAINING a type word was replaced by the bare type) discarded the occasion /
// subtype the classifier was told to preserve, leaving the semantic ranker
// nothing to judge fit by — so partial matches surfaced as strong cards.
// If the query names an audience (women/men/kids) anywhere, rewrite it as
// "<type> for <audience>" so the ranker reads the audience as a recipient
// CONSTRAINT, not a category. "ladies fashion" → "fashion for women";
// "ladies" → "for women"; "shoes for men" → "shoes for men". Returns null when
// no audience word is present (caller falls through to normal handling).
export function reframeAudienceQuery(query) {
  const tokens = query.split(" ").filter(Boolean);
  let audience = null;
  const rest = [];
  for (const token of tokens) {
    if (token.length <= 1) continue; // drop possessive "s" left by punctuation stripping
    const match = AUDIENCE_TERMS.find((a) => a.terms.includes(token));
    if (match) {
      if (!audience) audience = match.label; // first audience wins; extra audience words dropped
      continue;
    }
    rest.push(token);
  }
  if (!audience) return null;

  // Whatever product type is left, minus filler, becomes "<type> for <audience>".
  const typeWords = rest.filter((word) => !BROAD_QUERY_FILLER.has(word));
  return typeWords.length ? `${typeWords.join(" ")} for ${audience}` : `for ${audience}`;
}

export function normalizeBroadSearchQuery(rawQuery) {
  if (rawQuery?.trim() === '*') return '*';

  const query = normalizeText(rawQuery);
  if (!query) return "";

  // Audience reframing first — it must win over bare-type collapse so
  // "ladies fashion" becomes "fashion for women", not "fashion".
  const reframed = reframeAudienceQuery(query);
  if (reframed) return reframed;

  const contentWords = query
    .split(" ")
    .filter((word) => word && !BROAD_QUERY_FILLER.has(word));

  for (const rule of BROAD_SEARCH_KEYWORDS) {
    // Bare browse only: every remaining word is a generic/synonym word for this
    // broad type (e.g. "shoes", "ladies", "women"). A subtype ("handbags",
    // "sneakers") or a qualified query ("corporate shoes", "shoes for a
    // wedding") fails this and passes through unchanged for the ranker to judge.
    const isBareType =
      contentWords.length > 0 &&
      contentWords.every((word) => rule.broad.includes(word));
    if (isBareType) {
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
      let query = normalizeBroadSearchQuery(rawQuery);
      // Diagnostic: classifier's raw query vs what we search on. If the classifier
      // returned "*" or dropped the qualifier (e.g. "ladies" → "products"), the
      // issue is upstream of search; if normalization changed intent, it's here.
      logger.info(`[Query] classifier="${rawQuery}" → search="${query}"`);

      // Budget shorthand ("under 15k", "I get 20k") scales like price offers.
      const referencePrice = session.lastProduct?.price || null;
      const maxPrice = scaleOfferToContext(
        parsePossibleNumber(data.maxPrice),
        referencePrice,
      );

      // Safety net for "show me cheaper ones" style refinements: if the model
      // dropped the category and left only a budget word (or nothing), re-anchor
      // to whatever the customer was already browsing so we never drift to an
      // unrelated category. A budget alone must never trigger a blank/"cheap"
      // catalog-wide search.
      const BUDGET_ONLY = /^(cheap(er)?|affordable|budget|lower|cheaper ones?|less|reduced?|inexpensive|pocket[- ]?friendly)$/i;
      if ((!query || BUDGET_ONLY.test(query)) && query !== "*") {
        const anchor =
          toCleanString(session.lastSearch?.query) ||
          toCleanString(session.lastProduct?.category) ||
          "";
        if (anchor && anchor !== "*") query = normalizeBroadSearchQuery(anchor);
      }

      return maxPrice ? { query, maxPrice } : { query };
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
        // Buyer may volunteer order details in the same breath as an offer.
        ...extractCheckoutData(data),
      };

    case "accept_offer":
      return {
        finalPrice: parsePossibleNumber(data.finalPrice),
        // An acceptance often carries the buyer details too ("ok deal, I'm
        // John, john@x.com, deliver to 12 Allen Ave") — keep them for checkout.
        ...extractCheckoutData(data),
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
        ...extractCheckoutData(data),
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
  const sessionLanguage = normalizeLanguageName(session.language) || "english";

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

  const detected = normalizeLanguageName(aiOutput.language);

  // Per-message language: reply in the language of the CURRENT message. The
  // model returns the language it detected for this turn — and is instructed to
  // echo the previous preference ONLY when the message is too neutral to tell
  // (a bare "ok"/"yes", a number, an emoji). So we trust that detection directly
  // and never force the reply back to a stale language: write English when they
  // wrote English, Pidgin when they wrote Pidgin. Fall back to the session
  // language only if the model returned nothing, then to english.
  const language = detected || sessionLanguage || "english";

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

// Render the catalog summary into a single grounding line for the classifier.
// Counts let the model route confidently ("any bags?" → search, never "we have
// none"), but it must still fetch real items via a product action — so the line
// is explicit that the summary is NOT a source of product/price/stock truth.
function buildCatalogSnapshot(catalogSummary) {
  if (!catalogSummary || !catalogSummary.totalAvailable) {
    return "Store catalog: no products are in stock right now.";
  }

  const MAX_CATEGORIES = 30;
  const shown = catalogSummary.categories.slice(0, MAX_CATEGORIES);
  const list = shown.map((c) => `${c.name} (${c.count})`).join(", ");
  const hiddenCount = catalogSummary.categories.length - shown.length;
  const more = hiddenCount > 0 ? `, +${hiddenCount} more categories` : "";

  return (
    `Store catalog — categories in stock now, with item counts: ${list}${more}. ` +
    `Total available items: ${catalogSummary.totalAvailable}. ` +
    `Use this ONLY to route correctly (e.g. don't tell a customer the store is empty when a relevant category exists — search instead). ` +
    `NEVER quote a specific product, price, size, or stock from this summary; always confirm those through a product action.`
  );
}

function buildActionDecisionSystem(business, session, catalogSummary = null) {
  const contextStr = buildContextString(session);
  const catalogSnapshot = buildCatalogSnapshot(catalogSummary);
  const tone = business.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Your communication style is ${tone}.` : '';

  // Static instruction body — byte-identical across every call and every
  // business, so it can serve as a cached system prefix (Anthropic prompt
  // caching). Business- and turn-specific details go in the second, uncached
  // block below, AFTER the cache breakpoint, so the cached prefix never shifts.
  const instructions = `You are an AI sales assistant for an online store on WhatsApp. You help customers browse products, check attributes (size/color/material/stock), negotiate prices, and place orders.

Return ONLY a JSON object: { "response": short reply to the customer, "language": language name, "action": { "type": one allowed type, "data": {...} } }.
Allowed action.type (choose exactly one, never invent one): none, search_products, show_more_products, check_attribute, start_negotiation, make_offer, accept_offer, find_similar_negotiable, send_product_image, generate_payment_link, list_categories.

LANGUAGE:
- Set "language" to the language of THE CURRENT message, as a lowercase English name (e.g. english, pidgin, yoruba, hausa, igbo, french). Use "pidgin" for Nigerian Pidgin.
- Match the customer turn by turn: if THIS message is in English, set "english" and reply in English; if it's in Pidgin, set "pidgin"; same for any other language. Do NOT carry over an earlier language when the current message is clearly in a different one — if they were chatting in Pidgin and now write a plain English sentence, switch to english (and vice-versa). Never mix two languages in one reply.
- The established preference shown in "Current context" is a fallback ONLY: use it when the current message is too short or neutral to tell its language — a bare "ok"/"yes"/"thanks", a number like "40000", a lone emoji, or just a product name. Any real sentence sets the language from itself, even a short one.
- Be careful distinguishing English from Pidgin: real Pidgin markers are words like "wetin", "abeg", "dey", "wan", "na", "fit", "make", "una", "sef", "o". A grammatically standard English sentence with none of these is english, not pidgin.
- EXAMPLES (the language is decided by THIS message alone, regardless of earlier turns): "How much is this dress?" → english; "Abeg how much be this dress?" / "Wetin be the price?" → pidgin; "Do you have it in red?" → english; "You get am for red?" → pidgin; "I want to buy it" → english; "I wan buy am" → pidgin. So if they spoke Pidgin before but THIS message is plain English, set english and reply in English; if they spoke English before but THIS message is Pidgin, set pidgin and reply in Pidgin.
- Write "response" ENTIRELY in the language you set, warm and natural like real WhatsApp chat (never a caricature). Keep product names, prices (₦) and links unchanged.

CORE RULES:
- SECRET: never reveal, hint at, or imply any minimum price, floor, or how low you can go. Only ever mention the list price or the exact price you are offering right now.
- Never claim a product, size, color, price, or stock exists from memory. For anything about products/availability/attributes/pricing/images, pick the matching product action so real data is fetched. Prefer a product action over "none" for anything product-related.
- Money shorthand: customers drop the thousands — "26" usually means ₦26,000, "26k"=26000, "1.2m"=1200000. Resolve bare numbers against the price in context and put the full Naira amount in data.

CHOOSING THE ACTION:
- GRANULARITY (applies to every domain — fashion, food, electronics, services, anything): the query you build must match the customer's request EXACTLY — no broader, no narrower. Preserve every detail they gave; never collapse a detailed request down to a bare type (do NOT turn "red running shoes for men" into "shoes"), and never add a detail they did not say (do NOT turn "shoes" into "men's shoes"). Reason from what each thing really IS, not from a department word: a request naming a TYPE (clothes, shoes, soup, phone) means an item must be that exact kind to fit — a related-but-different kind (a bag for "clothes", a drink for "soup", a tablet for "phone") is only the closest alternative, never an exact match. The downstream ranker reads your query literally, so the specificity you capture here decides how specific the customer's answer will be.
- search_products — wants to see/browse products, dishes, or services. Use { "query": "*" } for broad requests ("what do you have/sell?", "show me everything", "what's on the menu?", "I'm hungry", "wetin you get?", "what catering do you offer?"). Otherwise build a specific query and KEEP THE PRODUCT/DISH/SERVICE TYPE plus EVERY real qualifier the customer gave — the more they specify, the more you preserve. Capture all of: type/brand, colour, gender/audience, size, material, occasion/use-case/setting, recipient, dietary need, and (for catering/events) headcount/guests, event type, and date/time. Examples: "I need shoes for a wedding"→"shoes for wedding"; "nice clothes for my woman"→"women clothes"; "a gift for my mum"→"gift for mum"; "vegan small chops for 50 guests on Saturday"→"vegan small chops for 50 guests saturday"; "drinks package for a birthday party"→"drinks package for birthday party". Drop only true filler ("I want", "please", "nice", "abeg", "how far"). Occasion, audience, headcount, and dietary needs are NOT filler — they decide which items actually fit. Add "maxPrice" in Naira only when they state a spending limit ("under 15k"→15000).
- Cheaper/affordable/budget request while already browsing a category: KEEP that same category in "query" (reuse the last product's category / last search from context) and put any limit in "maxPrice". Never build the query from the budget word and never drift to an unrelated category. Only switch category when they name a different product type.
- show_more_products — "show more", "see more", "next", "the rest".
- check_attribute — asks about size/color/material/fit/stock/dimensions. data: { productName (null = last product), attributeKey, requestedValue (or null) }.
- start_negotiation — asks for a discount/"last price"/reduction WITHOUT a number ("how much last?", "you fit reduce am?", "e too cost", "abeg do am for me").
- make_offer — proposes a specific price, any phrasing: "I fit do 25k", "can you do 18000?", "make I run am 26", "20k last", "oya collect 22", "na 25 I get", "I no fit pass 25". Put the resolved amount in data.offer. NEVER stall, "check", "confirm" or "get back to them" — pricing is resolved instantly; the system gives you the counter/acceptance/final price to deliver.
- accept_offer — clearly agrees to the price YOU last offered ("ok", "deal", "I'll take it").
- generate_payment_link — wants to buy/order/pay/checkout ("package am for me", "send me link make I pay", "I don gree"). data: { productName (null = last), quantity, email, customerName, location, selectedSize, selectedColor, selectedAttributes:[{name,value}], selectedModifiers:[] }. quantity = how many units of this product the customer wants, as a whole number — set it whenever they say a count ("two", "2", "3 of them", "a pair" = 2, "a dozen" = 12); leave it out (defaults to 1) when they don't state one. The price the system charges already multiplies by quantity, so never do that maths yourself. To place an order the system needs the buyer's name, email, and delivery location, plus a chosen value for every variant the product lists (size, colour, or ANY other attribute like storage, material, flavour) and a choice from every required food modifier group. Pull whatever the customer has given into data (customerName = their full name; location = their delivery address/area; email; selectedModifiers = chosen option names). For variant picks: put size in selectedSize and colour in selectedColor as before, and put any OTHER attribute choice in selectedAttributes as { name, value } using the attribute's exact name from the product (e.g. { "name": "Storage", "value": "256GB" }). Do NOT invent, guess, auto-fill, or assume any of these — and NEVER copy the example values shown anywhere in these instructions (names, emails, addresses, option values) into data. They are format illustrations, not customer data. A field goes into data ONLY when the customer actually typed that value in this conversation; otherwise leave it null/empty. The system then replies asking for exactly what's still missing, so it is always correct to leave a field out — it is never correct to fill it with a placeholder to "complete" the order. Always use this action for buy/checkout intent even when details are incomplete.
- CHECKOUT FOLLOW-UP: once you've asked the customer for order details (name, email, delivery location, size, colour, or a modifier choice), treat their next message that supplies any of those as continuing the SAME purchase → action generate_payment_link, with productName = the item being bought (from context) and every detail they just gave mapped into data. When the customer sends a bare reply that is clearly their details — a name, an email, and an address run together (e.g. "<their name>, <their email>, <their address>") — parse each part into customerName, email, and location respectively, using ONLY what they actually wrote (never a placeholder). Never restart a search or answer "none" when the customer is clearly answering your checkout questions.
- send_product_image — wants to SEE a product (picture/photo/"what does it look like?"). The ONLY way to send a photo.
- find_similar_negotiable — agrees to see similar items they can bargain on, or asks for them directly.
- list_categories — explicitly asks for category/department names.
- none — ONLY pure greetings, thanks, or chit-chat with no product interest.
- "it"/"that one" = the last product in context.

Current context is provided below.`;

  return [
    {
      type: "text",
      text: instructions,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text:
        `Business: "${business.name}".${toneInstruction}\n` +
        `The customer's established language preference for THIS conversation is: ${session.language || "english"}.\n\n` +
        `${catalogSnapshot}\n\n` +
        `Current context:\n${contextStr}`,
    },
  ];
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
- LANGUAGE (already decided for this conversation — obey it exactly, do not re-judge from the latest message): write EVERY sentence of your reply — opening, list intro, and closing line included — in ${session.language || "english"}. It must read warm and natural, the way real people actually chat on WhatsApp in that language, never stiff or an exaggerated caricature. Do not slip into another language anywhere, even if the customer's last message contained words from another language. Keep product names, prices (₦), and links exactly as given.
- HONESTY (most important): Only ever mention products, prices, sizes, colors, images, or stock that ACTUALLY appear in the action result or context above. Never invent, assume, or imply that the store has something. The catalog is the database — if it isn't in the result, it doesn't exist for you.
- For product search results:
  - If actionResult.count === 0 (or products is empty): clearly and politely tell the customer you don't currently have any product matching that. Do NOT pretend a match exists or describe an imaginary item. Offer to show available categories or ask them to describe what else they need.
  - actionResult.matchTier tells you how well the shown products fit the search:
    - "strong": they are what the customer asked for — present them confidently.
    - "partial": nothing genuinely fits what they asked for — be upfront that you don't have exactly that (e.g. nothing suited to the occasion or use they described), then present these as the closest items you do have, in case they're interested. Never pass a partial match off as the right product for their need — e.g. do NOT present sneakers as wedding shoes; say you don't have formal/wedding shoes right now and these casual options are what you have.
    - Never mention match percentages, scores, or tiers to the customer.
  - actionResult.searchBreadth tells you how specific the request was, so you can scale your confidence:
    - "broad": they named only a general type (e.g. "shoes") without narrowing it. Present the shown products as a representative selection — NOT as the one perfect item — and add ONE short, friendly line inviting them to narrow it down (by style, colour, size, occasion, or budget) so you can pin their exact match.
    - "specific": they gave real details. If matchTier is "strong", present the items confidently as matching exactly what they asked for. If "partial", be upfront you don't have that exact thing and offer these as the closest.
  - If displayMode is "none": NO products are being shown — no cards, no list. The search was specific and nothing is an exact match. Write a brief, honest message (1–2 sentences): say you don't currently have exactly what they asked for, describe in a few words what your closest items are like (e.g. "what I have leans more casual"), and offer to show those closest options or help them look for something else. Do NOT list or number any products.
  - If displayMode is "cards": the product images and full details are sent as separate cards right AFTER your message — so write only a SHORT intro line and do NOT list or repeat product details. Set the tone from searchBreadth: "broad" → introduce them as a selection and invite them to narrow down (style, colour, size, occasion, budget); otherwise a brief confident lead-in.
  - If displayMode is "text" (or absent): list ONLY the products in actionResult.products as a numbered list, one entry per product, numbering from actionResult.startNumber (default 1). Each entry MUST follow EXACTLY this format:
    1. *Product Name* - Short one-line description. Price: ₦18,000. Available in red, black, white, and blue, with sizes 39, 41, and 42.
    Build the "Available in ..." sentence from the product's actual attributes (colors, sizes, etc.); omit it when the product has no attributes. Use each product's real description, shortened to one line. Do not add anything else per entry.
    For food/dish items (isFood true): mention the prep time when present instead of sizes/colors, e.g. "1. *Jollof Rice with Chicken* - Smoky party-style jollof served with grilled chicken. Price: ₦4,500. Ready in ~25 mins." If soldOutForToday is true, end the entry with "(sold out for today)".
  - NEVER mention remaining items, extra items, or more products, and never invite the customer to reply "show more" — when more items actually exist, the system automatically appends that note for you. List or introduce ONLY what is in actionResult.products.
  - When actionResult.budget is present, the customer set a spending limit and these results are filtered to it. Present them as options within their budget. If actionResult.noneWithinBudget is true, gently say you don't have an item in THAT category under ₦<budget> right now — mention the cheapest one starts around ₦<cheapestInCategory> if given — and ask if they can stretch a little or want you to keep looking in the same category. Never jump to an unrelated category to fill the gap.
  - For any product where inStock is false (or stock is 0), say it is currently out of stock — do not present it as available to buy. For food items where soldOutForToday is true: if allowPreOrder is true, offer it as a pre-order; otherwise say it is sold out for today and suggest they check back tomorrow.
  - When a customer asks how long their food will take, use the product's prepTimeMins.
  - Keep it short and scannable.
- For attribute checks:
  - If available, confirm clearly.
  - If unavailable, say so and list available options if present.
  - Never confirm a size/color/variant that is not in the result.
- For product image requests: a product card with the photo (when available) and the FULL details is being sent to the customer right now. Write only a short, friendly one-line note to go with it (e.g. "Here's the {product} 👇"). Do NOT re-list the details and do not claim to attach anything else.
  - If hasImage is false, briefly mention a photo isn't available for it, but its full details are shown.
- For payment links: the order is confirmed — present a short, friendly order summary, THEN the link. The summary must read back what's in the result: the product (actionResult.product), the price (actionResult.price, ₦ formatted), the chosen size/colour (actionResult.selectedSize/selectedColor) and any selectedModifiers when present, the name it's under (actionResult.customerName), and the delivery location (actionResult.location). The price is the single, all-in figure — present it simply as the price; never mention tax, VAT, or any breakdown. For the link itself, write the EXACT literal placeholder {{PAYMENT_LINK}} (those exact characters, double curly braces) on its own line where the link should appear — do NOT write, guess, copy, complete, or "fix" any actual URL yourself (the system substitutes the real payment link for that placeholder). Also give the customer their order reference, actionResult.orderId, so they can quote it when they pay. Only mention details that are actually present in the result; never invent any. (The price already includes any modifier extra cost.)
- If the result has "needsInfo": true, the order is NOT placed yet and NO payment link exists — do not share or invent a link. The customer wants this product (actionResult.product, price actionResult.price); you just need the remaining details before creating the order. The system gathers these in stages, so actionResult.missing holds only the items to ask for RIGHT NOW — ask for EXACTLY those, all together in ONE warm, natural message, and nothing else. DON'T re-ask for anything in actionResult.collected (already provided — collected.attributes holds chosen variants, plus name/email/location; you may briefly acknowledge them). Map each missing entry by its "field":
    - "attribute": ask which "name" they want (e.g. Size, Colour, Storage) and list the available choices from its "options".
    - "modifiers": for each group in "groups", ask them to choose, listing every option with its extra cost when it has one (e.g. "Chicken +₦500, Beef +₦800"); never invent options.
    - "name": ask for the name the order should be under.
    - "email": ask for the email address for the order/receipt.
    - "location": ask for their delivery address/location.
  WRONG INPUT — if a missing entry has an "invalidValue", the customer DID send that detail this turn but it isn't valid (a malformed email like "john@gmail" with no domain, a not-a-real-name, a too-short address, or — for an attribute — a choice that isn't offered). Don't silently re-ask: gently and specifically tell them that what they sent (quote the invalidValue back to them) doesn't look like a valid name / email / delivery address, or for an attribute that it isn't one of the available options, and ask them to send a correct one. Keep it warm, not robotic (e.g. "Hmm, 'joegmail.com' doesn't look like a complete email — could you double-check and resend it?"). For an attribute, restate the real choices from "options".
  When "name" and "email" appear together, ask for both in the same breath ("Can I get your name and email for the order?"). Keep it friendly and conversational, not a stiff form. Once they reply, the next detail (or the payment link) follows automatically.
- UNAVAILABLE ADD-ONS — this applies to BOTH the payment-link and needsInfo results above: if actionResult.unavailableModifiers is present (a list), the customer asked for add-ons / options / toppings this product does NOT offer (e.g. an extra or side that isn't on the menu). You MUST flag each one by name and say it isn't available for this product — never silently ignore the request or pretend it was added. If the order is otherwise complete (a payment link is present), still share the link, but make clear those specific item(s) weren't included and the price reflects only what IS available. If you're still collecting details, mention the unavailable item(s) up front, then continue asking for what's missing. When the product genuinely has other add-ons, you may point them to the real ones.
- For price negotiation (the action result has a "negotiation" object):
  - SECRECY (non-negotiable rule): while bargaining, never reveal, hint at, or imply a minimum price, floor, or how low you can go. Only ever mention the list price or the exact price you are offering now. The ONLY exception is outcome "final" below — and even then, present negotiation.finalPrice simply as your final price, never as a "minimum", "floor", or "the lowest we're allowed to go".
  - PRICES ONLY MOVE DOWN: never state a counter or final price HIGHER than any price you already offered this customer for this product earlier in the conversation. The price in the action result is the standing commitment — quote exactly that number, and never resurrect an older, higher number from the chat history.
  - outcome "started": warmly invite the customer to make an offer. Do NOT name a discounted price yourself.
  - outcome "counter": you are countering at negotiation.counterPrice. Your reply MUST state that exact price (₦ formatted) as the price you are offering RIGHT NOW — never say you will check, confirm, or get back to the customer; the decision is already made. Present it as YOUR price and justify the number using the REAL qualities of this product from the "product" details — quality, material, features, popularity, and limited availability if product.lowStock is true. Be warm but hold the value; do not cave to the customer's number and do not mention any minimum. Style examples (do NOT copy them word-for-word; write your own in the same spirit): English — "Because of the quality on this one, the best I can do right now is ₦X."; Pidgin — "This one na original o — make we meet for ₦X, you no go regret am."
  - outcome "accept": the deal is agreed at negotiation.acceptedPrice. Confirm it enthusiastically and move the customer to payment using the link in the result.
  - outcome "final": negotiation.finalPrice is your FINAL price — the haggling is over. This is the price you already last offered them; you have come down as far as you can and will not reduce again. Tell them warmly and personally that this is genuinely the lowest you can let it go for — the best you can do for THEM on this item — and briefly tie it to the product's real value (quality/material/features) so it lands as a considered last offer, not a cold fixed price. It is still take-it-or-leave-it: do not apologise excessively, do not invite further offers, and do not budge if they keep pushing — just hold this same number. If it's beyond their budget, offer to show similar items they can negotiate on. Style examples (do NOT copy them word-for-word; write your own in the same spirit, and never write "Oga/Madam" literally — address the customer naturally or not at all): English — "I've stretched as far as I can on this one — ₦X is honestly the lowest I can let it go for, and for this quality it's a steal. Should I package it for you?"; Pidgin — "I don try reach my limit o — ₦X na the last, last price wey I fit sell am give you. For this kind quality, e worth am. Make I package am?"
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
    session.language && session.language !== "english"
      ? `\n\nFINAL REMINDER: every single sentence of the reply — opening, list intro, and closing line included — must be written in ${session.language}. Do not write any sentence in another language.`
      : ""
  }`;
}

// The classifier only needs recent conversational context — lastProduct and
// negotiation state already ride in the system context block — so cap the
// history sent to it. Bounds input tokens (and cost) on long haggling sessions.
const CLASSIFIER_HISTORY_LIMIT = 8;

// JSON-schema-constrained output for the classifier. With structured outputs the
// model can only return a well-formed object: a present "response" string, a
// valid action "type" from the enum, and a "data" object. This makes the
// empty-reply and invalid-action failure modes structurally impossible — the
// salvage logic in normalizeAiOutput becomes a thin safety net, not load-bearing.
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

// Every field any action can carry, unioned. Irrelevant fields come back null
// for a given action; normalizeActionData reads only the ones it needs.
const ACTION_DATA_PROPERTIES = {
  query: nullable({ type: "string" }),
  maxPrice: nullable({ type: "number" }),
  productName: nullable({ type: "string" }),
  attributeKey: nullable({ type: "string" }),
  requestedValue: nullable({ type: "string" }),
  offer: nullable({ type: "number" }),
  finalPrice: nullable({ type: "number" }),
  email: nullable({ type: "string" }),
  customerName: nullable({ type: "string" }),
  location: nullable({ type: "string" }),
  selectedSize: nullable({ type: "string" }),
  selectedColor: nullable({ type: "string" }),
  selectedAttributes: nullable({
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value"],
      properties: {
        name: { type: "string" },
        value: { type: "string" },
      },
    },
  }),
  selectedModifiers: nullable({ type: "array", items: { type: "string" } }),
};

const ACTION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["response", "language", "action"],
  properties: {
    response: { type: "string" },
    language: {
      type: "string",
      description:
        "The language the customer is writing in, as a lowercase English name (e.g. english, pidgin, yoruba, hausa, igbo, french, swahili, arabic). Use 'pidgin' for Nigerian Pidgin.",
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["type", "data"],
      properties: {
        type: { type: "string", enum: [...VALID_ACTION_TYPES] },
        data: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(ACTION_DATA_PROPERTIES),
          properties: ACTION_DATA_PROPERTIES,
        },
      },
    },
  },
};

// Claude requires the first message to be from the user and every message to
// carry non-empty content. A session's history can legitimately open with an
// assistant greeting, so drop leading assistant/empty turns before sending.
function toClaudeMessages(conversationHistory, userMessage) {
  const cleaned = conversationHistory
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content ?? "") }))
    .filter((m) => m.content.trim());

  while (cleaned.length && cleaned[0].role === "assistant") {
    cleaned.shift();
  }

  return [...cleaned, { role: "user", content: userMessage }];
}

/**
 * First AI call: given the user's message and session context, decide what
 * action to take and draft an initial response. Runs on Claude Haiku 4.5 with
 * JSON-schema-constrained output — chosen for stronger Nigerian Pidgin intent
 * comprehension and a guaranteed response shape.
 *
 * Returns: { response: string, action: { type: string, data: object } }
 */
export async function processMessage(userMessage, session = {}, business) {
  // Only the most recent turns matter for intent; lastProduct/negotiation
  // context already travels in the system block, so cap history to bound cost.
  const conversationHistory = Array.isArray(session.conversationHistory)
    ? session.conversationHistory.slice(-CLASSIFIER_HISTORY_LIMIT)
    : [];

  const fallback = {
    response: "I'm sorry, I encountered an error. Please try again.",
    action: { type: "none", data: {} },
  };

  // Catalog snapshot grounds the model's routing. It reads the 5-min-cached
  // product list (no extra DB query); if it fails for any reason, classify
  // without it rather than blocking the reply.
  let catalogSummary = null;
  try {
    catalogSummary = await getCatalogSummary(business?.id);
  } catch (error) {
    logger.warn(`[Classifier] Catalog summary unavailable: ${error.message}`);
  }

  try {
    const completion = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      // The structured response carries a free-form `response` draft PLUS the full
      // action.data object (every field required). A checkout/order turn is the
      // largest output the classifier emits, and 1024 truncated it mid-JSON —
      // safeJsonParse then failed and the customer got the generic error. Give it
      // real headroom; the model still stops at the end of the JSON, so this only
      // raises the ceiling, not the normal token spend.
      max_tokens: 4096,
      temperature: 0,
      system: buildActionDecisionSystem(business, session, catalogSummary),
      messages: toClaudeMessages(conversationHistory, userMessage),
      output_config: {
        format: { type: "json_schema", schema: ACTION_DECISION_SCHEMA },
      },
    });

    // Cache health: with the static instruction prefix cached, `cacheRead`
    // should dominate `input` after warmup (cached reads bill at ~0.1×). If
    // `cacheRead` stays 0 across messages, a silent invalidator slipped into the
    // cached block and you're paying full input rate every call. `cacheWrite`
    // is the ~1.25× premium paid only when (re)warming the prefix.
    const u = completion.usage || {};
    logger.info(
      `[Classifier usage] input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0} ` +
        `cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0}`,
    );

    const rawContent =
      (completion.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") || "{}";

    const parsed = safeJsonParse(rawContent);

    if (!parsed) {
      // A `max_tokens` stop means the JSON was cut off mid-stream (the usual cause
      // of unparseable output) — call it out so it's not mistaken for a model
      // formatting bug. Anything else is genuinely malformed output.
      if (completion.stop_reason === "max_tokens") {
        logger.warn(
          `processMessage hit max_tokens — response truncated and unparseable. ` +
            `Raise max_tokens. Partial: ${rawContent}`,
        );
      } else {
        logger.warn(`processMessage returned invalid JSON: ${rawContent}`);
      }
      return fallback;
    }

    return parsed;
  } catch (error) {
    logger.error("processMessage failed:", error);
    return fallback;
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

// ─── Localized product descriptions ───────────────────────────────────────────

// Vendor descriptions are written in English; non-English sessions get them
// translated so product cards match the conversation. Cached per
// language+product — the key includes the text itself, so an edited description
// re-translates.
const descriptionCache = new Map(); // `${language}:${id}:${description}` → { text, expiresAt }
const DESC_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Return copies of `products` with descriptions translated into `language`.
 * English (or empty/unknown) is a no-op. One batched model call per send covers
 * every uncached product; any failure leaves the original English description in
 * place.
 */
export async function translateDescriptions(products, language) {
  const lang = normalizeLanguageName(language);
  if (!lang || lang === "english" || !products.length) return products;

  const translated = new Map(); // product id → translated description
  const pending = [];

  for (const product of products) {
    const description = (product.description || '').trim();
    if (!description) continue;

    const cacheKey = `${lang}:${product.id}:${description}`;
    const hit = descriptionCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      translated.set(product.id, hit.text);
    } else {
      pending.push({ id: product.id, description });
    }
  }

  if (pending.length) {
    const prompt = `Translate each product description below into warm, natural ${lang} — the way people actually chat on WhatsApp, never an exaggerated caricature. Keep product names, brand names, numbers, and prices exactly as they are, and keep each translation about the same length as the original.

Respond with JSON: {"translations": {"<id>": "<translated description>"}} — one entry per item, using the exact ids given.

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
        descriptionCache.set(`${lang}:${id}:${description}`, {
          text,
          expiresAt: Date.now() + DESC_CACHE_TTL_MS,
        });
      }
    } catch (error) {
      logger.warn(
        `[i18n] Description translation to ${lang} failed (cards stay in English): ${error.message}`,
      );
    }
  }

  return products.map((p) =>
    translated.has(p.id) ? { ...p, description: translated.get(p.id) } : p,
  );
}

// ─── "More items" note (AI-written, code-guarded) ───────────────────────────────

/**
 * Compose the short "there are N more items — reply *show more*" line in the
 * session language. GROUNDING stays in code: the caller decides the exact `count`
 * and whether to show this at all (never the model) and then GUARDS the output —
 * the line must contain `count` and a "show more" cue or it's discarded for a
 * fixed template. This function only phrases those facts naturally; a bad
 * generation can never invent a count or offer "show more" when nothing remains.
 *
 * `asSuggestions` true → frame the items as close-but-not-exact alternatives;
 * false → frame them as more matches. Returns a string, or null on failure.
 */
export async function generateMoreItemsNote({ count, asSuggestions, language, business }) {
  const lang = normalizeLanguageName(language) || "english";
  const tone = business?.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Match this tone: ${tone}.` : "";
  const framing = asSuggestions
    ? `The ${count} item(s) are NOT an exact match for what the customer asked for, but could still be a good fit — be honest about that.`
    : `There are ${count} more item(s) that match what the customer asked for.`;

  const system =
    `You write ONE short, warm WhatsApp line (max ~25 words) letting a customer know there are more products they can see.${toneInstruction} ` +
    `Write it ENTIRELY in ${lang} — natural and conversational like real WhatsApp chat, never a caricature. ` +
    `${framing} ` +
    `You MUST include the exact number ${count}, and you MUST invite them to reply with the words *show more* (keep "show more" in English, wrapped in asterisks). ` +
    `Reply with ONLY the line — no quotes, no preamble, no extra sentences.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7, // a little variety so it doesn't read canned
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Compose the line. Number of other items: ${count}.` },
      ],
    });
    return completion.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    logger.warn(`[MoreItemsNote] generation failed (template used): ${error.message}`);
    return null;
  }
}

// ─── UI string localization ────────────────────────────────────────────────────

// Short, code-composed WhatsApp strings (show-more hints, error notices, the
// "great choice" prompt, etc.) are hand-written for English and Pidgin. For any
// OTHER language they are AI-translated once and cached — the set of rendered
// strings is tiny and repeats, so this is effectively all cache hits after warmup.
const uiStringCache = new Map(); // `${language}:::${text}` → translated

export async function translateUiString(text, language) {
  const lang = normalizeLanguageName(language);
  if (!text || !lang || lang === "english") return text;

  const key = `${lang}:::${text}`;
  const cached = uiStringCache.get(key);
  if (cached) return cached;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You translate short WhatsApp UI strings for an e-commerce assistant into ${lang}. Translate naturally and warmly, the way people actually chat on WhatsApp. Keep any *asterisk-wrapped* trigger words, emojis, numbers, ₦ amounts, links, and product names exactly as they are. Reply with ONLY the translation — no quotes, no notes.`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.2,
    });

    const result = completion.choices?.[0]?.message?.content?.trim() || text;
    uiStringCache.set(key, result);
    return result;
  } catch (error) {
    logger.warn(`[i18n] UI string translation to ${lang} failed; using English: ${error.message}`);
    return text;
  }
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

/**
 * Build the transcription `prompt` — domain context that biases the speech model
 * toward THIS store's real vocabulary so it spells product/dish/brand names and
 * Naira amounts correctly instead of guessing ("jollof", not "jelly of"). Framed
 * as "items this store sells" (not "what the customer said") to help recognition
 * without making the model hallucinate those names when they aren't spoken. The
 * multilingual note keeps it transcribing in the language actually spoken.
 */
async function buildTranscriptionPrompt(business) {
  if (!business?.id) return null;
  try {
    const vocab = await getCatalogVocabulary(business.id);
    const vocabStr = vocab.length
      ? ` Items this store sells include: ${vocab.join(", ")}.`
      : "";
    return (
      `A WhatsApp voice message from a customer to the Nigerian store "${business.name}". ` +
      `The speaker may use English, Nigerian Pidgin, Yoruba, Hausa or Igbo — transcribe in the language actually spoken, do not translate. ` +
      `Prices are in Naira.${vocabStr} ` +
      `Transcribe product/brand names, places and amounts accurately, and capture every detail the speaker gives.`
    );
  } catch (error) {
    logger.warn(`[Transcribe] vocabulary context unavailable: ${error.message}`);
    return null;
  }
}

export async function transcribeAudio(audioData, business = null) {
  const buffer = Buffer.isBuffer(audioData) ? audioData : audioData.buffer;
  const mimeType = Buffer.isBuffer(audioData)
    ? "audio/ogg"
    : audioData.mimeType || "audio/ogg";

  const extension = getAudioExtension(mimeType);

  const file = await toFile(buffer, `voice-note.${extension}`, {
    type: mimeType,
  });

  // gpt-4o-transcribe (over whisper-1) for noticeably better accuracy on
  // non-English and accented/noisy audio — notably Nigerian languages (Yoruba,
  // Hausa, Igbo) and Pidgin. No `language` is passed on purpose: the model
  // auto-detects the spoken language and transcribes IN that language (not
  // translating to English), so the downstream per-message classifier can detect
  // and reply in it. A `prompt` carrying the store's own vocabulary sharpens the
  // hard words (product/brand/dish names, amounts). Returns `{ text }` as before.
  const prompt = await buildTranscriptionPrompt(business);

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe",
    ...(prompt ? { prompt } : {}),
  });

  // Diagnostic: see exactly what was heard. If the transcript is wrong, the
  // problem is here (audio/vocabulary), not in intent understanding downstream.
  logger.info(`[Voice] transcribed: "${transcription.text}"`);

  return transcription.text;
}

// Nigeria (WAT, UTC+1) is the customer base — anchor "good morning/afternoon/
// evening" to local time rather than the server clock.
function getTimeOfDay() {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Africa/Lagos',
    }).format(new Date()),
  );
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

// gpt-4o-mini tends to format greetings like a formal letter — a "Dear
// [Customer's Name]," salutation, bracketed fill-in fields, and a "Warm
// regards, The X Team" sign-off. We never have the buyer's name and this is a
// live WhatsApp chat, so strip any of that the prompt didn't prevent.
function sanitizeGreeting(text) {
  if (!text) return '';
  return text
    // [Customer's Name], {name}, {{ store }} and similar placeholders
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{\{?[^}]*\}?\}/g, '')
    // a leading "Dear ...," salutation line
    .replace(/^\s*dear\b[^\n,]*,?[ \t]*\n?/i, '')
    // a letter-style closing ("Warm regards," / "Best," …) and everything after
    .replace(
      /\n+[ \t]*(warm regards|kind regards|best regards|regards|sincerely|cheers|best wishes|warmly|yours truly|best)\b[\s\S]*$/i,
      '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// We never know the customer's name, and these go out as a WhatsApp bubble, not
// an email — shared by every short system-composed message (greetings, payment
// follow-ups) to stop gpt-4o-mini formatting them like a formal letter.
const SHORT_MESSAGE_CONSTRAINTS =
  ' Write it as ONE short, friendly WhatsApp line (two at most). Do NOT address the customer by name or use any placeholder such as [Customer\'s Name] or [Name] — you do not know their name. Do NOT add a sign-off, signature, or team name (no "Warm regards", no "The Team"). No subject line, no letter formatting.';

export async function generateGreeting(type, business, language = 'english', userMessage = '') {
  const tone = business.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Your communication style is ${tone}.` : '';
  const languageInstruction = languageWritingInstruction(language);

  const formatConstraints = SHORT_MESSAGE_CONSTRAINTS;

  const timeOfDay = getTimeOfDay();

  // The configured greeting is only ever shown verbatim for a genuine first
  // visit. A returning customer (records already exist) gets a well-articulated,
  // time-aware "welcome back" — it must never reuse the configured greeting.
  const fallback =
    type === 'first_visit'
      ? business.aiConfig?.greetingMessage?.trim() || `Welcome to ${business.name}! 👋 How can I help you today?`
      : `Good ${timeOfDay}! Welcome back to ${business.name} 👋 How can I help you today?`;

  try {
    // When the customer's opening message already asks for something, the
    // greeting must NOT be a disconnected standalone line — it should warmly
    // acknowledge what they asked for and bridge into it (the actual answer /
    // product cards are sent right after, so the greeting must NOT itself answer
    // or list products).
    const bridge = userMessage
      ? ` The customer's message also asks for something specific: "${userMessage}". In the SAME greeting, briefly acknowledge that request and say you're pulling it up for them — but do NOT answer it, name prices, or list any products here (that follows immediately after). Just make the greeting flow naturally into it.`
      : '';

    const userPrompt =
      type === 'first_visit'
        ? `Write a warm, engaging welcome message for a brand-new customer chatting with us for the first time. Keep it short and WhatsApp-friendly.${bridge} Plain text only, no JSON, no markdown.${formatConstraints}`
        : `Write a short, warm "welcome back" message for a returning customer who was away for a while. It is currently ${timeOfDay} for them, so open with the matching time-of-day greeting (e.g. "Good ${timeOfDay}").${bridge || ' Make it feel personal and inviting.'} Plain text only, no JSON, no markdown.${formatConstraints}`;

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

    return sanitizeGreeting(completion.choices?.[0]?.message?.content) || fallback;
  } catch (error) {
    logger.error('generateGreeting failed:', error);
    return fallback;
  }
}

/**
 * Polite "you didn't finish checking out" nudge. Fired by the follow-up sweeper
 * roughly an hour after a payment link was sent and the customer went quiet
 * without paying. Warm and no-pressure — never pushy or guilt-trippy.
 */
export async function generatePaymentFollowUp(business, productName, amount, language = 'english') {
  const tone = business.aiConfig?.businessTone;
  const toneInstruction = tone ? ` Your communication style is ${tone}.` : '';
  const languageInstruction = languageWritingInstruction(language);

  const priceText = typeof amount === 'number' ? `₦${amount.toLocaleString()}` : null;

  const fallback =
    language === 'pidgin'
      ? `Hello! 👋 I still keep your ${productName}${priceText ? ` (${priceText})` : ''} ready for you. You wan make we complete the order? I dey here if you get any question.`
      : `Hi! 👋 Just checking in — your ${productName}${priceText ? ` (${priceText})` : ''} is still reserved for you. Would you like to complete your order? I'm happy to help if you have any questions.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an AI sales assistant for "${business.name}".${toneInstruction}${languageInstruction}`,
        },
        {
          role: 'user',
          content: `A customer began checking out "${productName}"${priceText ? ` for ${priceText}` : ''} — a payment link was sent — but they did not complete payment and have been quiet for about an hour. Write a SHORT, warm, no-pressure follow-up: gently let them know the item is still available/reserved and invite them to complete the order or ask any question. Do NOT be pushy, do NOT guilt them, and do NOT mention any discount unless told to. Plain text only.${SHORT_MESSAGE_CONSTRAINTS}`,
        },
      ],
      temperature: 0.7,
    });

    return sanitizeGreeting(completion.choices?.[0]?.message?.content) || fallback;
  } catch (error) {
    logger.error('generatePaymentFollowUp failed:', error);
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
          content: `You are a helpful AI assistant for "${business.name}".${languageWritingInstruction(language)}`,
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
