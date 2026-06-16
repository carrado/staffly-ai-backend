/**
 * Webhook Controller
 *
 * Handles incoming WhatsApp text, voice notes, and audio messages.
 * Routes each message by phone_number_id to the correct business.
 * Supports:
 * - product search
 * - search pagination / show more
 * - voice note transcription
 * - attribute checks
 * - negotiation
 * - payment link generation
 */

import { getBusinessByPhoneNumberId, getBusinessById } from "../models/Business.js";
import {
  getSession,
  setSession,
  setLastProduct,
  setNegotiation,
  clearNegotiation,
  hydrateSession,
  clearPendingFollowUp,
} from "../models/ConversationState.js";
import * as whatsapp from "../services/whatsapp.service.js";
import * as openaiService from "../services/openai.service.js";
import * as productService from "../services/product.service.js";
import * as paymentService from "../services/payment.service.js";
import * as emailService from "../services/email.service.js";
import { startNegotiation, evaluateOffer } from "../services/negotiation.service.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const SEARCH_PAGE_SIZE = 3;      // image cards per page for a specific search
const SEARCH_MAX_CARD_PAGES = 2; // card pages in chat before handing off to the online store
const STORE_URL_BASE = "https://velte.ng/stores";
const SEARCH_LIMIT = 50;
const BROWSE_PAGE_SIZE = 10;     // numbered text entries per page for a broad "*" browse
const BROWSE_LIMIT = 200;        // broad browse pages through the whole catalog
const SIMILAR_PAGE_SIZE = 4;     // text-only "similar negotiable" alternatives
const LOW_STOCK_THRESHOLD = 5;   // used to justify counter-offers ("only N left")
const STRONG_MATCH_PERCENT = 90; // matchPercent at/above this = what the customer asked for

// Fixed, code-composed strings the customer can see. AI-written replies mirror
// the customer's language on their own; these cover everything written in code.
// The session's `language` is detected each turn by the action-decision model.
const STRINGS = {
  english: {
    moreItems: (n) =>
      `I still have ${n} more item${n === 1 ? "" : "s"} — reply *show more* to see ${n === 1 ? "it" : "them"}.`,
    otherItems: (n) =>
      `I also have ${n} other item${n === 1 ? "" : "s"} that ${n === 1 ? "isn't" : "aren't"} exactly what you asked for but could still be a good fit — reply *show more* to see ${n === 1 ? "it" : "them"}.`,
    productGone:
      "Sorry, that product is no longer available. Tell me what you're looking for and I'll find something similar.",
    pickedFood: (name, mins) =>
      `Great choice! 😊 Would you like to order *${name}* now${mins ? ` — it'll be ready in ~${mins} mins` : ""}?`,
    pickedRetail: (name) =>
      `Great choice! 😊 Would you like to buy *${name}*, check a size or color, or negotiate the price?`,
    notUnderstood:
      "Sorry, I could not understand that message. Please send text or a clear voice note.",
    somethingWrong:
      "Sorry, something went wrong on my end. Please try that again in a moment 🙏",
  },
  pidgin: {
    moreItems: (n) =>
      `I still get ${n} more item${n === 1 ? "" : "s"} — reply *show more* make you see ${n === 1 ? "am" : "them"}.`,
    otherItems: (n) =>
      `I get ${n} other item${n === 1 ? "" : "s"} wey no be exactly wetin you ask for, but e fit still work for you — reply *show more* make you see ${n === 1 ? "am" : "them"}.`,
    productGone:
      "Sorry o, that product don finish. Tell me wetin you dey find make I show you something wey resemble am.",
    pickedFood: (name, mins) =>
      `Correct choice! 😊 You wan order *${name}* now${mins ? ` — e go ready in ~${mins} mins` : ""}?`,
    pickedRetail: (name) =>
      `Correct choice! 😊 You wan buy *${name}*, check size or color, or you wan price am small?`,
    notUnderstood:
      "Sorry, I no understand that message. Abeg send text or clear voice note.",
    somethingWrong:
      "Sorry, something spoil for my side. Abeg try am again small time 🙏",
  },
};

const t = (language) => STRINGS[language] || STRINGS.english;

// Async accessor for code-composed strings. English and Pidgin use the
// hand-written tables above; any other language gets an AI-translated, cached
// version (see openai.service translateUiString). `pick` renders the wanted
// string from a table, e.g. tr(language, (s) => s.moreItems(3)).
async function tr(language, pick) {
  const table = STRINGS[language];
  if (table) return pick(table);
  return openaiService.translateUiString(pick(STRINGS.english), language);
}

// Internal grounding markers we write into the conversation history — e.g.
// "[Sent product cards: ...]" — must NEVER reach the customer. The classifier
// and the response model both replay history verbatim, and they sometimes parrot
// the marker back into their reply (often truncated, like "[Sent product cards:").
// Strip any such fragment — closed or not — from every customer-facing message.
function stripInternalMarkers(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\[Sent product cards\b[^\]]*\]?/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The payment URL is money-critical and must reach the customer byte-for-byte.
// The reply model is NOT trusted to render it: it tends to "fix" URLs it deems
// odd (e.g. rewriting a localhost velte link to some other domain) or hallucinate
// one. So the model only leaves a {{PAYMENT_LINK}} placeholder; here we swap in
// the real link, overwrite any URL it invented anyway, and guarantee it's present.
function enforcePaymentLink(text, link) {
  if (!link) return text;
  let out = String(text ?? "").replace(/\{\{\s*PAYMENT_LINK\s*\}\}/gi, link);
  // Replace any other URL the model emitted (a rewrite/hallucination) with ours.
  const urls = out.match(/\bhttps?:\/\/\S+/gi) || [];
  for (const u of urls) {
    if (u !== link) out = out.split(u).join(link);
  }
  if (!out.includes(link)) out = `${out.trim()}\n\n${link}`;
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// AI-written, code-guarded "N more items — *show more*" line. The count and the
// decision to show it at all come from code (grounding); the model only phrases
// it. The result is accepted ONLY if it contains the exact count AND a "show
// more" cue — otherwise (or on failure) we fall back to the fixed template, so
// the offer can never carry a wrong count or be dropped.
async function composeMoreItemsHint({ count, asSuggestions, language, business }) {
  const template = await tr(language, (s) =>
    asSuggestions ? s.otherItems(count) : s.moreItems(count),
  );

  try {
    const note = await openaiService.generateMoreItemsNote({
      count,
      asSuggestions,
      language,
      business,
    });
    if (note && note.includes(String(count)) && /show more/i.test(note)) {
      return note;
    }
  } catch {
    // fall through to the guaranteed-correct template
  }

  return template;
}

function buildConversationHistory(
  currentHistory = [],
  userMessage,
  assistantMessage,
) {
  return [
    ...currentHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantMessage },
  ];
}

function createDefaultActionResult(message) {
  return { error: message };
}

function getResolvedProductName(actionData = {}, session = {}) {
  return actionData.productName || session.lastProduct?.name || null;
}

function mapProductForAI(product) {
  // 999 is the "untracked stock" sentinel — report it as unknown (in stock)
  // so the AI never quotes it as a literal count.
  const stock =
    typeof product.stock === "number" && product.stock !== 999
      ? product.stock
      : null;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    price: product.price,
    description: product.description,
    tags: product.tags || [],
    useCases: product.useCases || [],
    attributes: product.attributes || {},
    allow_negotiation: product.allow_negotiation,
    stock,
    inStock: stock === null ? true : stock > 0,
    lowStock: stock !== null && stock > 0 && stock <= LOW_STOCK_THRESHOLD,
    isFood: product.is_food || false,
    prepTimeMins: product.prep_time_mins ?? null,
    soldOutForToday: product.sold_out_for_today || false,
    allowPreOrder: product.allow_preorder || false,
    modifiers: product.modifiers || [],
  };
}

/**
 * Match the customer's chosen modifier option names against the product's
 * modifier groups. Server-side source of truth: the AI only relays names; the
 * groups, prices, and required rules come from the product itself.
 */
function resolveSelectedModifiers(product, selectedNames = []) {
  const picked = (selectedNames || []).map((n) => String(n).toLowerCase().trim());
  const selections = [];
  const missingRequired = [];

  for (const group of product.modifiers || []) {
    const matched = group.options.filter((o) =>
      picked.includes(o.name.toLowerCase()),
    );
    const chosen = group.multiSelect ? matched : matched.slice(0, 1);

    if (group.required && chosen.length === 0) {
      missingRequired.push(group);
      continue;
    }

    selections.push(
      ...chosen.map((o) => ({
        group: group.name,
        name: o.name,
        additionalPrice: o.additionalPrice || 0,
      })),
    );
  }

  const extraTotal = selections.reduce((sum, s) => sum + s.additionalPrice, 0);
  return { selections, missingRequired, extraTotal };
}

// A perfect order needs more than the product: a chosen size/colour when the
// product lists them, every required food modifier, and the buyer's name, email
// and delivery location. The next three helpers gather those across turns, work
// out what's still missing, and only place the order once nothing is.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Resolve a customer-typed value to the product's canonical option (case-
// insensitive). Returns null when the value isn't one of the real options, so a
// typo or a not-offered choice is treated as "still needs a valid pick".
function resolveOption(value, options = []) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  return options.find((o) => String(o).toLowerCase().trim() === v) || null;
}

// Merge the details supplied this turn with everything gathered on earlier turns
// so checkout info accumulates instead of resetting when the customer answers
// one question at a time. New non-null values win; prior values are kept.
function mergeCheckout(prior = {}, data = {}, resolvedProductName = null) {
  const modifiers = Array.isArray(data.selectedModifiers)
    ? data.selectedModifiers.filter(Boolean)
    : [];
  return {
    productName: resolvedProductName || prior.productName || null,
    email: data.email || prior.email || null,
    customerName: data.customerName || prior.customerName || null,
    location: data.location || prior.location || null,
    selectedSize: data.selectedSize || prior.selectedSize || null,
    selectedColor: data.selectedColor || prior.selectedColor || null,
    selectedModifiers: modifiers.length ? modifiers : prior.selectedModifiers || [],
    // A price agreed via negotiation overrides the list price; carried across
    // turns so a checkout completed later still closes at the agreed number.
    negotiatedPrice: prior.negotiatedPrice ?? null,
  };
}

// Everything still required before this product can become an order. `missing`
// is empty when the checkout is complete; otherwise each entry names a field the
// reply must ask for (size/color/modifiers carry their valid options).
function computeCheckoutGaps(product, checkout) {
  const attrs = product.attributes || {};
  const missing = [];

  let size = null;
  if (attrs.sizes?.length) {
    size = resolveOption(checkout.selectedSize, attrs.sizes);
    if (!size) missing.push({ field: "size", options: attrs.sizes });
  }

  let color = null;
  if (attrs.colors?.length) {
    color = resolveOption(checkout.selectedColor, attrs.colors);
    if (!color) missing.push({ field: "color", options: attrs.colors });
  }

  const modifierCheck = resolveSelectedModifiers(product, checkout.selectedModifiers);
  if (modifierCheck.missingRequired.length > 0) {
    missing.push({
      field: "modifiers",
      groups: modifierCheck.missingRequired.map((group) => ({
        name: group.name,
        multiSelect: group.multiSelect,
        options: group.options.map((o) => ({
          name: o.name,
          additionalPrice: o.additionalPrice,
        })),
      })),
    });
  }

  if (!checkout.customerName) missing.push({ field: "name" });
  if (!checkout.email || !EMAIL_RE.test(checkout.email)) missing.push({ field: "email" });
  if (!checkout.location) missing.push({ field: "location" });

  return {
    missing,
    selections: modifierCheck.selections,
    extraTotal: modifierCheck.extraTotal,
    size,
    color,
  };
}

/**
 * The single gate every checkout passes through. Accumulates the buyer details,
 * and EITHER returns a `needsInfo` result (so the reply asks for exactly what's
 * left, and the gathered details persist to the session for the next turn) OR,
 * when nothing is missing, places the order via runCheckout and clears the
 * gathered state. `negotiatedPrice` (when set) is the agreed unit price that
 * overrides the list price.
 */
async function gatherCheckoutOrAsk({
  businessId,
  customerNumber,
  product,
  data = {},
  negotiatedPrice = null,
}) {
  const prior = getSession(businessId, customerNumber).checkout || {};
  const checkout = mergeCheckout(prior, data, product.name);
  if (negotiatedPrice != null) checkout.negotiatedPrice = negotiatedPrice;

  const gaps = computeCheckoutGaps(product, checkout);
  const baseAmount = checkout.negotiatedPrice ?? product.price;
  const amount = baseAmount + gaps.extraTotal;
  const negotiated = checkout.negotiatedPrice != null;

  if (gaps.missing.length > 0) {
    // Keep this product in focus and remember what we've gathered so far.
    setLastProduct(businessId, customerNumber, product);
    const s = getSession(businessId, customerNumber);
    setSession(businessId, customerNumber, { ...s, checkout });
    return {
      needsInfo: true,
      product: product.name,
      price: amount,
      negotiated,
      missing: gaps.missing,
      collected: {
        size: checkout.selectedSize || null,
        color: checkout.selectedColor || null,
        name: checkout.customerName || null,
        email: checkout.email || null,
        location: checkout.location || null,
      },
    };
  }

  const result = await runCheckout({
    businessId,
    customerNumber,
    product,
    amount,
    email: checkout.email,
    customerName: checkout.customerName,
    location: checkout.location,
    selectedSize: gaps.size,
    selectedColor: gaps.color,
    selectedModifiers: gaps.selections,
  });

  // Order placed — clear the gathered checkout (and any finished negotiation) so
  // the next purchase starts clean.
  clearNegotiation(businessId, customerNumber);
  const s = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, { ...s, checkout: null });
  return { ...result, negotiated };
}

/**
 * Checkout handoff. Single source of truth for turning an agreed price into a
 * payment link + invoice. Both the buy flow and an accepted negotiation call
 * into this so the logic isn't duplicated.
 */
async function runCheckout({
  businessId,
  customerNumber,
  product,
  amount,
  email,
  customerName,
  location,
  selectedSize,
  selectedColor,
  selectedModifiers = [],
}) {
  setLastProduct(businessId, customerNumber, product);

  // E.g. "Jollof Rice (Chicken, Extra Plantain)" on the payment link/invoice.
  const itemLabel = selectedModifiers.length
    ? `${product.name} (${selectedModifiers.map((m) => m.name).join(', ')})`
    : product.name;

  const { paymentLink, orderId } = await paymentService.generatePaymentLink(
    businessId,
    customerNumber,
    itemLabel,
    amount,
    { customerName, customerEmail: email, location },
  );

  // Arm an abandoned-checkout follow-up. If the customer pays (payment webhook)
  // or sends any further message (handled at the top of handleIncomingMessage),
  // this is cleared; otherwise the sweeper nudges them ~1 hour from now.
  const sessionBeforeCheckout = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, {
    ...sessionBeforeCheckout,
    pendingFollowUp: {
      orderId,
      productName: product.name,
      amount,
      createdAt: new Date(),
      sentAt: null,
    },
  });

  await emailService.sendInvoiceEmail(email || `${customerNumber}@staffly.app`, {
    product,
    orderId,
    amount,
    customerName,
    location,
  });

  return {
    paymentLink,
    orderId,
    product: product.name,
    price: amount,
    customerName: customerName || null,
    location: location || null,
    email: email || null,
    selectedSize: selectedSize || null,
    selectedColor: selectedColor || null,
    selectedModifiers: selectedModifiers.map((m) => ({
      group: m.group,
      name: m.name,
      additionalPrice: m.additionalPrice,
    })),
  };
}

/**
 * Card captions print product.description verbatim — for non-English sessions,
 * translate it into the session language so the card matches the conversation.
 * The card's fixed labels and button title are handled by whatsapp.service's own
 * string table.
 */
async function localizeProductsForLanguage(products, language) {
  if (!products.length) return products;
  return openaiService.translateDescriptions(products, language);
}

async function sendOutboundMessage({
  phoneNumberId,
  accessToken,
  customerNumber,
  responseText,
  productsToShow = [],
  language = "english",
}) {
  const products = await localizeProductsForLanguage(productsToShow, language);

  if (products.length === 1) {
    await whatsapp.sendProductCard(
      phoneNumberId,
      accessToken,
      customerNumber,
      products[0],
      responseText,
      language,
    );
    return;
  }

  if (products.length > 1) {
    await whatsapp.sendProductList(
      phoneNumberId,
      accessToken,
      customerNumber,
      products,
      responseText,
      "",
      language,
    );
    return;
  }

  await whatsapp.sendTextMessage(
    phoneNumberId,
    accessToken,
    customerNumber,
    responseText,
  );
}

/**
 * Customer tapped "Pick this one" on a product card. No AI round-trip needed:
 * resolve the product from the button id, remember it as the session's
 * lastProduct, and send its full card with a next-step prompt.
 */
async function handleProductSelection({
  phoneNumberId,
  accessToken,
  businessId,
  customerNumber,
  productId,
}) {
  const product = await productService.getProductById(productId);
  const language = getSession(businessId, customerNumber).language;

  if (!product) {
    await whatsapp.sendTextMessage(
      phoneNumberId,
      accessToken,
      customerNumber,
      await tr(language, (s) => s.productGone),
    );
    return;
  }

  setLastProduct(businessId, customerNumber, product);

  const followUpText = product.is_food
    ? await tr(language, (s) => s.pickedFood(product.name, product.prep_time_mins))
    : await tr(language, (s) => s.pickedRetail(product.name));

  const [localized] = await localizeProductsForLanguage([product], language);

  await whatsapp.sendProductCard(
    phoneNumberId,
    accessToken,
    customerNumber,
    localized,
    followUpText,
    language,
  );

  const currentSession = getSession(businessId, customerNumber);

  setSession(businessId, customerNumber, {
    ...currentSession,
    conversationHistory: buildConversationHistory(
      currentSession.conversationHistory || [],
      `I picked this product: ${product.name}`,
      followUpText,
    ),
    lastMessageAt: new Date(),
  });
}

async function extractUserMessage(message, accessToken, business) {
  try {
    if (message.type === "text") {
      return message.text?.body?.trim() || "";
    }

    // Other interactive replies (non-product buttons / list picks): treat the
    // tapped label as the customer's message.
    if (message.type === "interactive") {
      const reply =
        message.interactive?.button_reply || message.interactive?.list_reply;
      return reply?.title?.trim() || "";
    }

    if (message.type === "voice" || message.type === "audio") {
      const mediaId = message.voice?.id || message.audio?.id;

      if (!mediaId) {
        throw new Error("No media ID found for audio message");
      }

      const audioData = await whatsapp.downloadMedia(mediaId, accessToken);

      const transcription = await openaiService.transcribeAudio(audioData, business);

      if (!transcription) {
        throw new Error("Empty transcription");
      }

      return transcription.trim();
    }

    return "";
  } catch (error) {
    logger.error("[Voice Error]", error);

    return "__VOICE_ERROR__";
  }
}


async function executeAction({
  action,
  businessId,
  customerNumber,
  session,
  shownProductIds = new Set(),
}) {
  let actionResult = null;
  let productsToShow = [];
  let asPickableCards = false; // search results carry a "Pick this one" button

  switch (action.type) {
    case "search_products": {
      const query = action.data.query?.trim();

      if (!query) {
        actionResult = createDefaultActionResult(
          "I could not tell what to search for. Please mention the product, category, or what you want to use it for.",
        );
        break;
      }

      // A broad "what do you have?" browse (query "*") lists the catalog as
      // numbered text, 10 per page. A specific enquiry shows pickable image
      // cards, 4 per page.
      const isBroadBrowse = query === "*";
      const pageSize = isBroadBrowse ? BROWSE_PAGE_SIZE : SEARCH_PAGE_SIZE;

      const { products: allMatches, specificity: searchBreadth } =
        await productService.searchProducts(
          businessId,
          query,
          isBroadBrowse ? BROWSE_LIMIT : SEARCH_LIMIT,
        );

      // Budget refinement ("cheaper ones", "under 15k"): keep the same
      // category matches the search returned, just drop anything above the
      // customer's limit. The category stays intact — we never swap in
      // unrelated items to fill the page.
      const maxPrice =
        typeof action.data.maxPrice === "number" && action.data.maxPrice > 0
          ? action.data.maxPrice
          : null;
      const found = maxPrice
        ? allMatches.filter((p) => typeof p.price === "number" && p.price <= maxPrice)
        : allMatches;

      logger.info(
        `[Search] "${query}"${maxPrice ? ` (≤₦${maxPrice})` : ""} → ${found.length} match(es) for business ${businessId}`,
      );

      // Results arrive ordered by matchPercent. The strong tier (≥90%) is
      // what the customer literally asked for; everything below is "close".
      const strongCount = isBroadBrowse
        ? found.length
        : found.filter((p) => (p.matchPercent ?? 100) >= STRONG_MATCH_PERCENT)
            .length;

      // Page 1 never mixes tiers: with 1–3 strong matches, show ONLY those —
      // the lower-tier items are announced as "other items you might like"
      // instead of padding the page. With more strong matches than fit, or
      // none at all, page normally from the top of the list.
      const productsToDisplay =
        !isBroadBrowse && strongCount > 0 && strongCount < pageSize
          ? found.slice(0, strongCount)
          : found.slice(0, pageSize);
      const remainingCount = Math.max(
        found.length - productsToDisplay.length,
        0,
      );

      // True when everything left beyond this page is lower-tier — switches
      // the appended hint from "N more items" to "N other items you might like".
      const remainingAreSuggestions =
        !isBroadBrowse && strongCount > 0 && remainingCount > 0 &&
        strongCount <= productsToDisplay.length;

      // A partial match (specific search, no strong/exact fit) is NOT shown as
      // cards — we send only an honest text message. Cards are reserved for
      // strong matches; a broad browse stays a numbered text list.
      const isPartialMatch = !isBroadBrowse && found.length > 0 && strongCount === 0;

      if (found.length > 0) {
        setLastProduct(businessId, customerNumber, found[0]);
        if (!isBroadBrowse && strongCount > 0) {
          productsToShow = productsToDisplay;
          asPickableCards = true;
        }
      }

      const currentSession = getSession(businessId, customerNumber);

      setSession(businessId, customerNumber, {
        ...currentSession,
        browseMode: "search",
        lastSearch: {
          query,
          productIds: found.map((product) => product.id),
          // Nothing was shown for a partial match, so a later "show more" starts
          // from the top rather than skipping the first page.
          offset: isPartialMatch ? 0 : productsToDisplay.length,
          strongCount,
        },
      });

      actionResult = {
        query,
        count: found.length,
        shownCount: isPartialMatch ? 0 : productsToDisplay.length,
        // Partial matches show nothing, so there is no "show more" to offer.
        remainingCount: isPartialMatch ? 0 : remainingCount,
        remainingAreSuggestions,
        // "strong": the shown products are what the customer asked for.
        // "partial": nothing matched closely — these are the nearest fits.
        matchTier: isBroadBrowse ? undefined : strongCount > 0 ? "strong" : "partial",
        // "broad": bare-type query → present a selection and invite narrowing.
        // "specific": constraints given → match precisely or be honest.
        searchBreadth,
        startNumber: 1,
        // "cards" for strong matches, "text" for a broad browse, "none" for a
        // partial match (message only — no product list, no cards).
        displayMode: isBroadBrowse ? "text" : strongCount > 0 ? "cards" : "none",
        products: productsToDisplay.map(mapProductForAI),
        // Budget context so the reply can say "here are <category> within your
        // budget" — and, when nothing fits, stay in-category instead of drifting.
        ...(maxPrice
          ? {
              budget: maxPrice,
              // The category had items, just none under their limit.
              noneWithinBudget: found.length === 0 && allMatches.length > 0,
              cheapestInCategory:
                found.length === 0 && allMatches.length > 0
                  ? allMatches
                      .map((p) => p.price)
                      .filter((n) => typeof n === "number")
                      .sort((a, b) => a - b)[0] ?? null
                  : null,
            }
          : {}),
      };

      break;
    }

    case "show_more_products": {
      const currentSession = getSession(businessId, customerNumber);

      // Text-only pagination for the "similar negotiable" alternatives list.
      if (
        currentSession.browseMode === "similar" &&
        currentSession.similarSearch?.productIds?.length
      ) {
        const similar = currentSession.similarSearch;
        const allSimilar = await productService.getProductsByIds(similar.productIds);

        const start = similar.offset || 0;
        const nextSimilar = allSimilar.slice(start, start + SIMILAR_PAGE_SIZE);
        const newOffset = start + nextSimilar.length;
        const remainingCount = Math.max(allSimilar.length - newOffset, 0);

        setSession(businessId, customerNumber, {
          ...currentSession,
          similarSearch: { ...similar, offset: newOffset },
        });

        actionResult = nextSimilar.length
          ? {
              similar: true,
              count: allSimilar.length,
              shownCount: nextSimilar.length,
              remainingCount,
              products: nextSimilar.map(mapProductForAI),
            }
          : createDefaultActionResult(
              "That's all the similar items I have for now.",
            );

        productsToShow = []; // text only — no product images for alternatives
        break;
      }

      const lastSearch = currentSession.lastSearch;

      if (!lastSearch?.productIds?.length) {
        actionResult = createDefaultActionResult(
          "There is no previous product search to continue. Please tell me what you are looking for.",
        );
        break;
      }

      const allProducts = await productService.getProductsByIds(lastSearch.productIds);

      // Match the original browse type: numbered text pages of 10 for a broad
      // "*" browse, pickable image cards of 4 for a specific search.
      const isBroadBrowse = lastSearch.query === "*";
      const pageSize = isBroadBrowse ? BROWSE_PAGE_SIZE : SEARCH_PAGE_SIZE;

      const start = lastSearch.offset || 0;

      // After SEARCH_MAX_CARD_PAGES pages of cards, stop paginating in chat:
      // when products still remain, hand the customer off to the business's
      // online store, where the whole catalog is browsable.
      if (
        !isBroadBrowse &&
        start >= SEARCH_PAGE_SIZE * SEARCH_MAX_CARD_PAGES &&
        allProducts.length > start
      ) {
        const business = getBusinessById(businessId);
        actionResult = {
          storeHandoff: true,
          query: lastSearch.query,
          moreProductsCount: allProducts.length - start,
          storeLink: `${STORE_URL_BASE}/${business?.velteUserId || businessId}`,
        };
        break;
      }

      const nextProducts = allProducts.slice(start, start + pageSize);
      const newOffset = start + nextProducts.length;
      const remainingCount = Math.max(allProducts.length - newOffset, 0);

      // Once pagination has moved past the strong tier, what's left is the
      // lower-match tier — keep the "other items you might like" framing.
      const strongCount = lastSearch.strongCount ?? 0;
      const remainingAreSuggestions =
        !isBroadBrowse && strongCount > 0 && remainingCount > 0 &&
        newOffset >= strongCount;

      if (nextProducts.length > 0) {
        setLastProduct(businessId, customerNumber, nextProducts[0]);
        if (!isBroadBrowse) {
          productsToShow = nextProducts;
          asPickableCards = true;
        }
      }

      setSession(businessId, customerNumber, {
        ...currentSession,
        lastSearch: {
          ...lastSearch,
          offset: newOffset,
        },
      });

      actionResult = {
        query: lastSearch.query,
        count: allProducts.length,
        shownCount: nextProducts.length,
        remainingCount,
        remainingAreSuggestions,
        startNumber: start + 1, // continue the numbered list across pages
        displayMode: productsToShow.length ? "cards" : "text",
        products: nextProducts.map(mapProductForAI),
      };

      break;
    }

    case "check_attribute": {
      const { attributeKey, requestedValue } = action.data;
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : session.lastProduct;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I could not identify which product you mean. Please mention the product name.",
        );
        break;
      }

      // A follow-up about a product whose card was already shown this session
      // stays as plain chat — re-send the photo + details only the first time
      // this product comes up.
      const alreadyShown = shownProductIds.has(product.id);

      if (!attributeKey) {
        actionResult = createDefaultActionResult(
          `I found ${product.name}, but I could not tell which attribute you want to check.`,
        );
        setLastProduct(businessId, customerNumber, product);
        productsToShow = alreadyShown ? [] : [product];
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      const check = productService.checkAttribute(
        product,
        attributeKey,
        requestedValue,
      );

      actionResult = {
        product: product.name,
        attributeKey,
        requestedValue: requestedValue ?? null,
        ...check,
      };

      productsToShow = alreadyShown ? [] : [product];
      break;
    }

    case "generate_payment_link": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "Product not found. Please tell me exactly which product you want to buy.",
        );
        break;
      }

      // Gather size/colour, required modifiers, name, email and location —
      // asking for whatever's still missing — and only place the order once the
      // checkout is complete.
      actionResult = await gatherCheckoutOrAsk({
        businessId,
        customerNumber,
        product,
        data: action.data,
      });

      break;
    }

    case "start_negotiation": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I could not tell which product you want to negotiate on. Please mention the product name.",
        );
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      // Rule B — fixed-price product: don't haggle, offer alternatives instead.
      if (!product.allow_negotiation) {
        clearNegotiation(businessId, customerNumber);
        actionResult = {
          nonNegotiable: true,
          product: product.name,
          price: product.price,
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // Mid-haggle "you no fit reduce am?" gets classified as start_negotiation
      // too. Resetting would forget the prices already quoted and let the next
      // counter jump back UP — a quoted price is a commitment. If a negotiation
      // for this product already has a standing quote, restate it instead.
      const existing = getSession(businessId, customerNumber).negotiation;
      if (
        existing?.productId === product.id &&
        Number.isFinite(existing.lastCounter)
      ) {
        actionResult = {
          negotiation:
            existing.stage === "final"
              ? {
                  outcome: "final",
                  finalPrice: existing.lastCounter,
                  listPrice: existing.originalPrice,
                  product: product.name,
                }
              : {
                  outcome: "counter",
                  counterPrice: existing.lastCounter,
                  listPrice: existing.originalPrice,
                  round: existing.rounds,
                  product: product.name,
                },
          product: mapProductForAI(product),
        };
        productsToShow = [];
        break;
      }

      const negotiation = startNegotiation(businessId, customerNumber, product);

      // NOTE: never expose minPrice — it stays server-side only.
      actionResult = {
        negotiation: {
          outcome: "started",
          product: product.name,
          listPrice: negotiation.originalPrice,
        },
        message: "Negotiation started — invite the customer to make an offer.",
      };

      break;
    }

    case "make_offer": {
      const freshSession = getSession(businessId, customerNumber);
      let activeNegotiation = freshSession.negotiation;

      const productName =
        activeNegotiation?.productName || freshSession.lastProduct?.name || null;

      const product = productName
        ? await productService.getProductByName(businessId, productName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I could not tell which product you want to negotiate on. Please mention the product name.",
        );
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      // Rule B — fixed-price product: explain and offer alternatives.
      if (!product.allow_negotiation) {
        clearNegotiation(businessId, customerNumber);
        actionResult = {
          nonNegotiable: true,
          product: product.name,
          price: product.price,
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // Start a negotiation lazily if none is active for THIS product.
      if (!activeNegotiation || activeNegotiation.productId !== product.id) {
        activeNegotiation = startNegotiation(businessId, customerNumber, product);
      }

      // "26" on a ₦30,000 product means ₦26,000 — rescue shorthand the model
      // passed through literally before the engine prices it as an insult bid.
      const offer = openaiService.scaleOfferToContext(
        action.data.offer,
        product.price,
      );

      const decision = evaluateOffer(activeNegotiation, offer);
      setNegotiation(businessId, customerNumber, decision.negotiation);

      // Rule F — accepted price: hand off to the existing checkout flow.
      if (decision.outcome === "accept") {
        const checkout = await runCheckout({
          businessId,
          customerNumber,
          product,
          amount: decision.acceptedPrice,
        });
        clearNegotiation(businessId, customerNumber);

        actionResult = {
          negotiation: {
            outcome: "accept",
            acceptedPrice: decision.acceptedPrice,
            product: product.name,
          },
          ...checkout,
          negotiated: true,
          agreedPrice: decision.acceptedPrice,
        };
        break;
      }

      // The customer keeps bidding under the hidden floor — the floor is now
      // quoted openly as the take-it-or-leave-it final price.
      if (decision.outcome === "final") {
        actionResult = {
          negotiation: {
            outcome: "final",
            finalPrice: decision.finalPrice,
            listPrice: product.price,
            product: product.name,
          },
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // Counter — provide the product's real qualities so the model can justify
      // the number. The hidden floor is never included.
      actionResult = {
        negotiation: {
          outcome: "counter",
          counterPrice: decision.counterPrice,
          listPrice: product.price,
          round: decision.negotiation.rounds,
          product: product.name,
        },
        product: mapProductForAI(product),
      };
      productsToShow = [];
      break;
    }

    case "accept_offer": {
      const freshSession = getSession(businessId, customerNumber);
      const negotiation = freshSession.negotiation;

      const productName = negotiation?.productName || freshSession.lastProduct?.name || null;
      const product = productName
        ? await productService.getProductByName(businessId, productName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I lost track of which product we were negotiating. Please tell me the product name.",
        );
        break;
      }

      // The agreed price is the last price WE offered, then the customer's
      // latest offer, then the AI-detected final price. Clamp to [floor, list]
      // so we never close below the hidden floor or above the list price.
      const floor = negotiation?.minPrice ?? 0;
      let agreedPrice =
        negotiation?.lastCounter ??
        negotiation?.currentOffer ??
        action.data.finalPrice ??
        product.price;
      agreedPrice = Math.min(Math.max(agreedPrice, floor), product.price);

      // Same checkout gate as a direct buy, but at the agreed (negotiated) price.
      // If buyer details are still missing this returns needsInfo and we keep the
      // negotiation alive; once everything's in, the order is placed.
      const checkout = await gatherCheckoutOrAsk({
        businessId,
        customerNumber,
        product,
        data: action.data,
        negotiatedPrice: agreedPrice,
      });

      if (checkout.needsInfo) {
        actionResult = checkout;
        break;
      }

      clearNegotiation(businessId, customerNumber);

      actionResult = {
        negotiation: {
          outcome: "accept",
          acceptedPrice: agreedPrice,
          product: product.name,
        },
        ...checkout,
        negotiated: true,
        agreedPrice,
      };

      break;
    }

    case "find_similar_negotiable": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const baseProduct = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : session.lastProduct;

      if (!baseProduct) {
        actionResult = createDefaultActionResult(
          "Tell me which product you'd like alternatives for and I'll find similar items you can negotiate on.",
        );
        break;
      }

      const similar = await productService.findSimilarNegotiableProducts(
        businessId,
        baseProduct,
      );

      const currentSession = getSession(businessId, customerNumber);

      if (!similar.length) {
        setSession(businessId, customerNumber, {
          ...currentSession,
          similarSearch: null,
        });
        actionResult = {
          similar: true,
          baseProduct: baseProduct.name,
          count: 0,
          shownCount: 0,
          remainingCount: 0,
          products: [],
        };
        productsToShow = [];
        break;
      }

      const shown = similar.slice(0, SIMILAR_PAGE_SIZE);
      const remainingCount = Math.max(similar.length - shown.length, 0);

      setSession(businessId, customerNumber, {
        ...currentSession,
        browseMode: "similar",
        similarSearch: {
          baseProductId: baseProduct.id,
          productIds: similar.map((p) => p.id),
          offset: shown.length,
        },
      });

      actionResult = {
        similar: true,
        baseProduct: baseProduct.name,
        count: similar.length,
        shownCount: shown.length,
        remainingCount,
        products: shown.map(mapProductForAI),
      };
      productsToShow = []; // text only — no product images for alternatives
      break;
    }

    case 'list_categories': {
      const categories = await productService.getProductCategories(businessId);
    
      if (!categories.length) {
        actionResult = {
          message: "No products available yet.",
          categories: [],
        };
        break;
      }
    
      actionResult = {
        message: "Available product categories",
        categories,
        count: categories.length,
      };
    
      productsToShow = []; // no product cards
    
      break;
    }

    case "send_product_image": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : session.lastProduct;

      if (!product) {
        actionResult = createDefaultActionResult(
          "Tell me which product you'd like to see and I'll send its picture and details.",
        );
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      const hasImage = whatsapp.sendableImageUrl(product) !== null;

      // A product card sends the photo (when available) WITH the full details;
      // the AI reply rides along as a short friendly note. This is the only
      // action that sends an image.
      productsToShow = [product];

      actionResult = {
        product: product.name,
        price: product.price,
        hasImage,
      };
      break;
    }

    case "none":
    default:
      actionResult = null;
      break;
  }

  return { actionResult, productsToShow, asPickableCards };
}

export async function handleIncomingMessage(req, res) {
  res.sendStatus(200);

  // Set as soon as we know who to reply to, so the catch block can still
  // answer the customer if anything below throws.
  let replyContext = null;

  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;

    // Delivery receipts (sent/delivered/read/failed). A failed status is the
    // ONLY signal Meta gives when it accepts a message (HTTP 200) but cannot
    // deliver it — e.g. an unsupported media type — so log it loudly instead
    // of dropping it with the other receipts.
    if (value?.statuses?.length) {
      for (const status of value.statuses) {
        if (status.status === "failed") {
          const details = (status.errors || [])
            .map((e) => `${e.code} ${e.title}${e.error_data?.details ? ` — ${e.error_data.details}` : ""}`)
            .join("; ");
          logger.error(
            `[Webhook] Delivery FAILED to ${status.recipient_id} (message ${status.id}): ${details || "no error details"}`,
          );
        }
      }
      return;
    }

    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const customerNumber = message.from;
    const phoneNumberId = value.metadata?.phone_number_id;
    const messageId = message.id;

    if (!customerNumber || !phoneNumberId) {
      logger.warn("[Webhook] Missing customerNumber or phoneNumberId");
      return;
    }

    const business = getBusinessByPhoneNumberId(phoneNumberId);

    if (!business) {
      logger.warn(
        `[Webhook] No business found for phone_number_id: ${phoneNumberId}`,
      );
      return;
    }

    const { access_token: accessToken, id: businessId } = business;

    // Load this customer's saved session from Mongo into the cache before any
    // synchronous read below — this is what makes absence detection (and the
    // rest of the session) survive a process restart.
    await hydrateSession(businessId, customerNumber);

    replyContext = {
      phoneNumberId,
      accessToken,
      customerNumber,
      language: getSession(businessId, customerNumber).language,
    };

    // Mark read and show the "typing…" bubble before we start composing, so the
    // customer sees activity while the AI works (it auto-clears when we reply).
    await whatsapp.sendTypingIndicator(phoneNumberId, accessToken, messageId);

    // "Pick this one" tap on a product card — resolve it directly.
    const buttonReply =
      message.type === "interactive"
        ? message.interactive?.button_reply || message.interactive?.list_reply
        : null;

    if (buttonReply?.id?.startsWith("select_product:")) {
      await handleProductSelection({
        phoneNumberId,
        accessToken,
        businessId,
        customerNumber,
        productId: buttonReply.id.slice("select_product:".length),
      });
      return;
    }

    const userMessage = await extractUserMessage(message, accessToken, business);

    if (userMessage === "__VOICE_ERROR__") {
      // Generate smart AI fallback message
      const fallback = await openaiService.generateVoiceErrorMessage(
        business,
        replyContext.language,
      );
    
      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        fallback
      );
    
      return;
    }

    if (!userMessage) {
      logger.warn(
        `[${business.name}] Empty or unsupported message from ${customerNumber}`,
      );

      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        await tr(replyContext.language, (s) => s.notUnderstood),
      );

      return;
    }

    const session = getSession(businessId, customerNumber);

    // The customer is back and engaging, so cancel any armed abandoned-checkout
    // follow-up. If this very turn generates a fresh payment link, runCheckout
    // re-arms it; if they're just chatting or asking about another product, it
    // stays cancelled and the sweeper never nudges them.
    if (session.pendingFollowUp) {
      clearPendingFollowUp(businessId, customerNumber);
    }

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const absenceMs = session.lastMessageAt
      ? Date.now() - new Date(session.lastMessageAt).getTime()
      : null;

    const isFirstVisit = !session.lastMessageAt;
    const isReturningAfterAbsence = absenceMs !== null && absenceMs > ONE_HOUR_MS;

    // A product card (image + full details) is only re-displayed when the buyer
    // turns to a DIFFERENT product. Once a product's card has been shown in this
    // conversation session, follow-up questions about that same item flow as
    // plain text. The set is reset when a new session begins (first visit, or a
    // return after a long absence).
    const newConversationSession = isFirstVisit || isReturningAfterAbsence;
    const shownProductIds = new Set(
      newConversationSession ? [] : session.shownProductIds || [],
    );

    let activeSession = session;
    let greetingWasSent = false;

    // The AI-config welcome message is reserved for the very first chat. Any
    // return after an hour+ of silence gets an AI-constructed "welcome back".
    let greeting = null;

    if (isFirstVisit) {
      // A configured greeting is shown verbatim; an AI-generated one bridges into
      // whatever the customer just asked for so it isn't a disconnected line.
      greeting =
        business.aiConfig?.greetingMessage?.trim() ||
        (await openaiService.generateGreeting("first_visit", business, session.language, userMessage));
    } else if (isReturningAfterAbsence) {
      greeting = await openaiService.generateGreeting(
        "welcome_back",
        business,
        session.language,
        userMessage,
      );
    }

    if (greeting) {
      await whatsapp.sendTextMessage(phoneNumberId, accessToken, customerNumber, greeting);
      await new Promise((r) => setTimeout(r, 600));

      // Sending the greeting cleared the typing bubble — re-trigger it (same
      // inbound message id) so the customer sees "typing…" again while we
      // compose the actual reply. Clears once more when that reply goes out.
      await whatsapp.sendTypingIndicator(phoneNumberId, accessToken, messageId);

      greetingWasSent = true;
      activeSession = {
        ...session,
        conversationHistory: [
          ...(session.conversationHistory || []),
          { role: "assistant", content: greeting },
        ],
      };
    }

    const rawAiOutput = await openaiService.processMessage(
      userMessage,
      activeSession,
      business,
    );

    const aiOutput = openaiService.normalizeAiOutput(rawAiOutput, activeSession);
    let action = aiOutput.action;
    const language = aiOutput.language;
    replyContext.language = language;

    // Safety net: mid-negotiation, a message carrying a money amount IS a bid.
    // If the model still failed to classify it, route it to the engine rather
    // than letting a stalling "none" reply go out. The list price anchors
    // shorthand: "make I run am 26" on a ₦30,000 item reads as ₦26,000.
    if (action.type === "none" && session.negotiation) {
      const fallbackOffer = openaiService.extractOfferAmount(
        userMessage,
        session.negotiation.originalPrice || session.lastProduct?.price || null,
      );
      if (fallbackOffer !== null) {
        action = { type: "make_offer", data: { offer: fallbackOffer } };
        logger.info(
          `[${business.name}] Bid fallback: reclassified "none" as make_offer(₦${fallbackOffer})`,
        );
      }
    }

    logger.info(
      `[${business.name}] Normalized action: ${action.type} (language: ${language})`,
    );

    let responseText = stripInternalMarkers(aiOutput.response);

    if (action.type !== "none") {
      const { actionResult, productsToShow, asPickableCards } = await executeAction({
        action,
        businessId,
        customerNumber,
        session,
        shownProductIds,
      });

      const freshSession = getSession(businessId, customerNumber);

      // The "show more" hint is AI-written but code-guarded: code decides the
      // exact count and whether to show it at all (it must only ever appear when
      // items genuinely remain), the model only phrases it naturally, and a bad
      // generation falls back to the fixed template. When everything left is a
      // lower-tier match, it's framed as suggestions instead of more results.
      const remainingCount = actionResult?.remainingCount;
      const moreItemsHint =
        typeof remainingCount === "number" && remainingCount > 0
          ? await composeMoreItemsHint({
              count: remainingCount,
              asSuggestions: !!actionResult?.remainingAreSuggestions,
              language,
              business,
            })
          : null;

      const sendingCards = asPickableCards && productsToShow.length > 0;

      if (sendingCards) {
        // Strong, specific matches: the cards speak for themselves — no intro
        // bubble. A BROAD search (a wide selection that should invite narrowing)
        // gets a short AI intro line before the cards. (Partial matches never
        // reach this branch — they're sent as a message only, no cards.)
        const needsIntro = actionResult?.searchBreadth === "broad";

        let introText = "";
        if (needsIntro) {
          const composed = await openaiService.generateResponseWithActionResult(
            userMessage,
            { ...freshSession, language },
            actionResult,
            business,
          );
          introText = stripInternalMarkers(composed.response);
        }

        const localizedCards = await localizeProductsForLanguage(
          productsToShow,
          language,
        );

        // The intro (when needed) is the header bubble; the more-items hint
        // goes out after the last card.
        await whatsapp.sendProductList(
          phoneNumberId,
          accessToken,
          customerNumber,
          localizedCards,
          introText,
          moreItemsHint || "",
          language,
        );

        // History note (never sent) so follow-ups like "the second one" or
        // "the jollof" stay grounded in exactly what was shown.
        responseText = `${introText ? `${introText}\n` : ""}[Sent product cards: ${productsToShow
          .map((p) => p.name)
          .join(", ")}]${moreItemsHint ? ` ${moreItemsHint}` : ""}`;
      } else {
        // The stored session still has last turn's language — inject this
        // turn's detection so the reply switches languages without lag.
        const finalAiOutput =
          await openaiService.generateResponseWithActionResult(
            userMessage,
            { ...freshSession, language },
            actionResult,
            business,
          );

        responseText = stripInternalMarkers(finalAiOutput.response);

        // Force the exact payment URL in (the model isn't trusted to render it).
        if (actionResult?.paymentLink) {
          responseText = enforcePaymentLink(responseText, actionResult.paymentLink);
        }

        if (moreItemsHint) {
          responseText += `\n\n${moreItemsHint}`;
        }

        await sendOutboundMessage({
          phoneNumberId,
          accessToken,
          customerNumber,
          responseText,
          productsToShow,
          language,
        });
      }

      // Remember every card we just put on screen so later questions about the
      // same item stay text-only.
      for (const p of productsToShow) {
        if (p?.id != null) shownProductIds.add(p.id);
      }
    } else if (!greetingWasSent) {
      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        responseText,
      );
    }

    const currentSession = getSession(businessId, customerNumber);

    // Spread the whole session so fields written during executeAction
    // (browseMode, similarSearch, ...) survive the turn.
    setSession(businessId, customerNumber, {
      ...currentSession,
      conversationHistory: buildConversationHistory(
        currentSession.conversationHistory || [],
        userMessage,
        responseText,
      ),
      shownProductIds: [...shownProductIds],
      language,
      lastMessageAt: new Date(),
    });

    logger.info(`[${business.name}] → replied to ${customerNumber}`);
  } catch (error) {
    // Meta/axios errors carry the useful detail in response.data
    logger.error("[Webhook] Unhandled error:", error.response?.data || error);

    // Never leave the customer on read — always attempt a fallback reply.
    if (replyContext) {
      try {
        await whatsapp.sendTextMessage(
          replyContext.phoneNumberId,
          replyContext.accessToken,
          replyContext.customerNumber,
          t(replyContext.language).somethingWrong,
        );
      } catch {
        // the send channel itself is down — nothing more we can do
      }
    }
  }
}
