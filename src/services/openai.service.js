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
    const numericValue = Number(value.replace(/[^\d.]/g, ""));
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  return null;
}

function buildContextString(session) {
  const { lastProduct, negotiation } = session;
  let contextStr = "";

  if (lastProduct) {
    contextStr += `\n--- Last Product Discussed ---\n${buildProductContext(lastProduct)}\n`;
  }

  if (negotiation) {
    contextStr += `\n--- Ongoing Negotiation ---\n`;
    contextStr += `Product: ${negotiation.productName}\n`;
    contextStr += `Original price: ₦${negotiation.originalPrice?.toLocaleString()}\n`;
    contextStr += `Minimum price: ₦${negotiation.minPrice?.toLocaleString()}\n`;
    contextStr += `Current offer: ${
      negotiation.currentOffer
        ? `₦${negotiation.currentOffer.toLocaleString()}`
        : "none"
    }\n`;
    contextStr += `Stage: ${negotiation.stage || "unknown"}\n`;
  }

  return contextStr || "No current context.";
}

function normalizeBroadSearchQuery(rawQuery) {
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

    case "generate_payment_link":
      return {
        productName:
          toNullableString(data.productName) ||
          session.lastProduct?.name ||
          null,
        email: toNullableString(data.email),
        selectedSize: toNullableString(data.selectedSize),
        selectedColor: toNullableString(data.selectedColor),
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
  const fallback = {
    response: "I'm sorry, I encountered an error. Please try again.",
    action: { type: "none", data: {} },
  };

  if (!aiOutput || typeof aiOutput !== "object") {
    return fallback;
  }

  const response =
    typeof aiOutput.response === "string" && aiOutput.response.trim()
      ? aiOutput.response.trim()
      : "I'm here to help.";

  const rawAction =
    aiOutput.action && typeof aiOutput.action === "object"
      ? aiOutput.action
      : { type: "none", data: {} };

  const type = VALID_ACTION_TYPES.has(rawAction.type) ? rawAction.type : "none";
  const data = normalizeActionData(type, rawAction.data, session);

  if (type === "search_products" && !data.query) {
    return { response, action: { type: "none", data: {} } };
  }

  if (type === "check_attribute" && !data.attributeKey) {
    return { response, action: { type: "none", data: {} } };
  }

  if (type === "start_negotiation" && !data.productName) {
    return { response, action: { type: "none", data: {} } };
  }

  if (type === "make_offer" && data.offer === null) {
    return { response, action: { type: "none", data: {} } };
  }

  if (type === "accept_offer" && data.finalPrice === null) {
    return { response, action: { type: "none", data: {} } };
  }

  if (type === "generate_payment_link" && !data.productName) {
    return { response, action: { type: "none", data: {} } };
  }

  return {
    response,
    action: {
      type,
      data,
    },
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
  "action": {
    "type": "none" | "search_products" | "check_attribute" | "start_negotiation" | "make_offer" | "accept_offer" | "generate_payment_link",
    "data": {}
  }
}

Rules:
- You MUST choose exactly one action.type from the allowed list.
- Never invent a new action type.
- Prefer a business action over "none" when the customer is asking about products, attributes, pricing, negotiation, or payment.
- Use "search_products" when the customer wants to browse, find, see, or ask about products or categories.
- Use "check_attribute" when the customer asks about size, color, material, fit, stock variant, capacity, dimensions, or any specific product attribute.
- Use "generate_payment_link" when the customer wants to buy, order, pay, checkout, or proceed with purchase.
- Use "start_negotiation" when the customer asks for discount, better price, last price, reduction, or negotiation.
- Use "make_offer" when there is an active negotiation and the customer gives a specific price.
- Use "accept_offer" only when the customer clearly agrees to a negotiated final price.
- Use "none" only for greetings, thanks, clarification, or casual conversation that requires no business action.
- If the customer says "it", "that one", or similar, use the last product from context.
- Use "show_more_products" when the customer says "show more", "see more", "next", "more products", "can I see more", "can you show me the rest" or wants to continue the previous product search.
- Use "search_products" when the customer wants to search by product name, description, category, similar words, or what the item is used for.
- If the customer says "something used in the kitchen", search query should be "kitchen".
- Use "list_categories" when the user asks:
  - "Do you have products?"
  - "What do you sell?"
  - "What do you have?"
  - "What is available?"
  - "What products are in your store?"

Very important search rules:
- search_products is NOT only for exact product names.
- For broad requests, use broad category search queries.
- Examples:
  - "show me fashion items" -> { "query": "fashion" }
  - "what clothes do you have?" -> { "query": "clothes" }
  - "do you have bags?" -> { "query": "bags" }
  - "show me shoes" -> { "query": "shoes" }
  - "anything for ladies?" -> { "query": "female fashion" }
  - "what do you have for men?" -> { "query": "male fashion" }
- If the user asks for a type/category of product, do NOT force an exact product name.
- Keep the response concise and WhatsApp-friendly.

Action data rules:
- search_products → { "query": "broad category, product type, or product-related phrase" }
- check_attribute → {
    "productName": "product name or null if last product should be used",
    "attributeKey": "sizes | colors | material | stock | dimensions | etc",
    "requestedValue": "specific value or null"
  }
- start_negotiation → { "productName": "product name or null if last product should be used" }
- make_offer → { "offer": 25000 }
- accept_offer → { "finalPrice": 25000 }
- generate_payment_link → {
    "productName": "exact product name or null if last product should be used",
    "email": "customer email if provided or null",
    "selectedSize": "chosen size if provided or null",
    "selectedColor": "chosen color if provided or null"
  }
- show_more_products → {}
- search_products → { "query": "product name, category, description, use case, or related phrase" }
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
- For product search results:
  - List the products returned in the action result.
  - Mention name, price, and a short useful detail from description or attributes.
  - If remainingCount > 0, tell the customer there are more items available beyond the ones shown now.
  - If remainingCount === 0, do not mention any extra remaining items.
  - Keep it short and scannable.
  - For product search results:
  - List only the products in actionResult.products.
  - Mention name, price, and why it matches.
  - If remainingCount > 0, say: "I still have {remainingCount} more item(s). Reply 'show more' to see them."
  - If remainingCount === 0, do not mention remaining items.
- For attribute checks:
  - If available, confirm clearly.
  - If unavailable, say so and list available options if present.
- For payment links: confirm product, selected options, price, and share the link naturally.
- For negotiation:
  - If offer is below minimum, respond politely and guide the customer.
  - If acceptable, respond naturally and clearly.
- For category listing:
  - Tell the user the store has products.
  - Mention categories clearly.
  - Do NOT list individual product names.
  - Keep it friendly and conversational.
- If there is an error, explain it clearly and guide the customer on the next step.
- Plain text only.
- No JSON.
- Keep it concise for WhatsApp.`;
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

export async function generateVoiceErrorMessage(business) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful AI assistant for "${business.name}".`,
        },
        {
          role: "user",
          content:
            "A user sent a voice note but it failed to process. Politely ask them to send a text message instead. Keep it short, friendly, and conversational like WhatsApp.",
        },
      ],
      temperature: 0.5,
    });

    return (
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I couldn't process your voice note. Please send your message as text 🙏"
    );
  } catch (error) {
    logger.error("Voice fallback AI failed:", error);

    return "Sorry, I couldn't process your voice note. Please send your message as text 🙏";
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
