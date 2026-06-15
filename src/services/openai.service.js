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
      let query = normalizeBroadSearchQuery(toCleanString(data.query));

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

  // Language preference is sticky and asymmetric, so it can't fluctuate.
  // English is the unmarked default; any other language, once the customer
  // clearly writes in it, becomes their established preference for the rest of
  // the chat. Customers drop in English words, numbers, or a quick "ok" all the
  // time — that is NOT a switch — so a plain-English/blank turn never pulls them
  // back out of their language. A different concrete language DOES switch them.
  const language =
    detected && detected !== "english"
      ? detected
      : sessionLanguage !== "english"
        ? sessionLanguage
        : detected || "english";

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

function buildActionDecisionSystem(business, session) {
  const contextStr = buildContextString(session);
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
- Set "language" to the language the customer is writing in, as a lowercase English name (e.g. english, pidgin, yoruba, hausa, igbo, french). Use "pidgin" for Nigerian Pidgin.
- The established preference is in "Current context" and is STICKY: english is the default, but once the customer clearly writes in another language, stay in it. Mixed-in English words, numbers, or "ok"/"yes"/"how much?" never switch it. Never flip back to English just because a message was short.
- Write "response" ENTIRELY in that language, warm and natural like real WhatsApp chat (never a caricature). Keep product names, prices (₦) and links unchanged.

CORE RULES:
- SECRET: never reveal, hint at, or imply any minimum price, floor, or how low you can go. Only ever mention the list price or the exact price you are offering right now.
- Never claim a product, size, color, price, or stock exists from memory. For anything about products/availability/attributes/pricing/images, pick the matching product action so real data is fetched. Prefer a product action over "none" for anything product-related.
- Money shorthand: customers drop the thousands — "26" usually means ₦26,000, "26k"=26000, "1.2m"=1200000. Resolve bare numbers against the price in context and put the full Naira amount in data.

CHOOSING THE ACTION:
- search_products — wants to see/browse products. Use { "query": "*" } for broad requests ("what do you have/sell?", "show me everything", "what's on the menu?", "I'm hungry", "wetin you get?"). Use a specific query for a type/category and KEEP the product type/brand plus every real qualifier — color, gender, AND any occasion / use-case / setting / recipient ("I need shoes for a wedding"→"shoes for wedding"; "something to wear to the office"→"office wear"; "a gift for my mum"→"gift for mum"; "I wan buy nice shoes for men"→"men shoes"). Drop only true filler like "I want", "please", "nice", "abeg". The occasion/use-case is NOT filler — it decides which products actually fit. Add "maxPrice" in Naira only when they state a spending limit ("under 15k"→15000).
- Cheaper/affordable/budget request while already browsing a category: KEEP that same category in "query" (reuse the last product's category / last search from context) and put any limit in "maxPrice". Never build the query from the budget word and never drift to an unrelated category. Only switch category when they name a different product type.
- show_more_products — "show more", "see more", "next", "the rest".
- check_attribute — asks about size/color/material/fit/stock/dimensions. data: { productName (null = last product), attributeKey, requestedValue (or null) }.
- start_negotiation — asks for a discount/"last price"/reduction WITHOUT a number ("how much last?", "you fit reduce am?", "e too cost", "abeg do am for me").
- make_offer — proposes a specific price, any phrasing: "I fit do 25k", "can you do 18000?", "make I run am 26", "20k last", "oya collect 22", "na 25 I get", "I no fit pass 25". Put the resolved amount in data.offer. NEVER stall, "check", "confirm" or "get back to them" — pricing is resolved instantly; the system gives you the counter/acceptance/final price to deliver.
- accept_offer — clearly agrees to the price YOU last offered ("ok", "deal", "I'll take it").
- generate_payment_link — wants to buy/order/pay/checkout ("package am for me", "send me link make I pay", "I don gree"). data: { productName (null = last), email, selectedSize, selectedColor, selectedModifiers:[] }. For food with modifier groups, pass the chosen option names; if a required group is unchosen, still use this action — the system says what's missing.
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
- For payment links: confirm the product, selected options, and price, then share actionResult.paymentLink EXACTLY as given — a bare URL, never altered, shortened, wrapped in markdown, or invented. Also give the customer their order reference, actionResult.orderId, so they can quote it when they pay. If the result includes selectedModifiers, confirm those choices as part of the order (the price already includes their extra cost).
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
  selectedSize: nullable({ type: "string" }),
  selectedColor: nullable({ type: "string" }),
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

  try {
    const completion = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      temperature: 0,
      system: buildActionDecisionSystem(business, session),
      messages: toClaudeMessages(conversationHistory, userMessage),
      output_config: {
        format: { type: "json_schema", schema: ACTION_DECISION_SCHEMA },
      },
    });

    const rawContent =
      (completion.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") || "{}";

    const parsed = safeJsonParse(rawContent);

    if (!parsed) {
      logger.warn(`processMessage returned invalid JSON: ${rawContent}`);
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

export async function generateGreeting(type, business, language = 'english') {
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
    const userPrompt =
      type === 'first_visit'
        ? `Write a warm, engaging welcome message for a brand-new customer chatting with us for the first time. Keep it short and WhatsApp-friendly. Plain text only, no JSON, no markdown.${formatConstraints}`
        : `Write a short, warm "welcome back" message for a returning customer who was away for a while. It is currently ${timeOfDay} for them, so open with the matching time-of-day greeting (e.g. "Good ${timeOfDay}"). Make it feel personal and inviting. Plain text only, no JSON, no markdown.${formatConstraints}`;

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

export async function textToSpeech(text) {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
  });

  return Buffer.from(await mp3.arrayBuffer());
}
