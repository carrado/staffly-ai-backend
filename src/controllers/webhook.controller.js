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
} from "../models/ConversationState.js";
import * as whatsapp from "../services/whatsapp.service.js";
import * as openaiService from "../services/openai.service.js";
import * as productService from "../services/product.service.js";
import * as paymentService from "../services/payment.service.js";
import * as emailService from "../services/email.service.js";
import { startNegotiation, evaluateOffer } from "../services/negotiation.service.js";
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
      `I also have ${n} other item${n === 1 ? "" : "s"} you might like — reply *show more* to see ${n === 1 ? "it" : "them"}.`,
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
      `I still get ${n} other item${n === 1 ? "" : "s"} wey fit catch your eye — reply *show more* make you see ${n === 1 ? "am" : "them"}.`,
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
  selectedSize,
  selectedColor,
  selectedModifiers = [],
}) {
  setLastProduct(businessId, customerNumber, product);

  // E.g. "Jollof Rice (Chicken, Extra Plantain)" on the payment link/invoice.
  const itemLabel = selectedModifiers.length
    ? `${product.name} (${selectedModifiers.map((m) => m.name).join(', ')})`
    : product.name;

  const { paymentLink, orderId } = paymentService.generatePaymentLink(
    businessId,
    customerNumber,
    itemLabel,
    amount,
  );

  await emailService.sendInvoiceEmail(email || `${customerNumber}@staffly.app`, {
    product,
    orderId,
    amount,
  });

  return {
    paymentLink,
    orderId,
    product: product.name,
    price: amount,
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
 * Card captions print product.description verbatim — for Pidgin sessions,
 * translate it so the card matches the conversation. The card's fixed labels
 * and button title are handled by whatsapp.service's own string table.
 */
async function localizeProductsForLanguage(products, language) {
  if (language !== "pidgin" || !products.length) return products;
  return openaiService.translateDescriptionsToPidgin(products);
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
  const strings = t(language);

  if (!product) {
    await whatsapp.sendTextMessage(
      phoneNumberId,
      accessToken,
      customerNumber,
      strings.productGone,
    );
    return;
  }

  setLastProduct(businessId, customerNumber, product);

  const followUpText = product.is_food
    ? strings.pickedFood(product.name, product.prep_time_mins)
    : strings.pickedRetail(product.name);

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

      const transcription = await openaiService.transcribeAudio(audioData);

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


async function executeAction({ action, businessId, customerNumber, session }) {
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

      const found = await productService.searchProducts(
        businessId,
        query,
        isBroadBrowse ? BROWSE_LIMIT : SEARCH_LIMIT,
      );

      logger.info(
        `[Search] "${query}" → ${found.length} match(es) for business ${businessId}`,
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

      if (found.length > 0) {
        setLastProduct(businessId, customerNumber, found[0]);
        // Only specific searches send image cards with a "Pick this one"
        // button; a broad browse stays a numbered text list.
        if (!isBroadBrowse) {
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
          offset: productsToDisplay.length,
          strongCount,
        },
      });

      actionResult = {
        query,
        count: found.length,
        shownCount: productsToDisplay.length,
        remainingCount,
        remainingAreSuggestions,
        // "strong": the shown products are what the customer asked for.
        // "partial": nothing matched closely — these are the nearest fits.
        matchTier: isBroadBrowse ? undefined : strongCount > 0 ? "strong" : "partial",
        startNumber: 1,
        displayMode: productsToShow.length ? "cards" : "text",
        products: productsToDisplay.map(mapProductForAI),
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

      if (!attributeKey) {
        actionResult = createDefaultActionResult(
          `I found ${product.name}, but I could not tell which attribute you want to check.`,
        );
        setLastProduct(businessId, customerNumber, product);
        productsToShow = [product]; // show the product's photo + details
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

      productsToShow = [product]; // show the product's photo + details
      break;
    }

    case "generate_payment_link": {
      const { email, selectedSize, selectedColor, selectedModifiers } = action.data;
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

      // Modifier check — every required group needs a chosen option before we
      // can take payment; selected options add their cost to the price.
      const modifierCheck = resolveSelectedModifiers(product, selectedModifiers);

      if (modifierCheck.missingRequired.length > 0) {
        setLastProduct(businessId, customerNumber, product);
        actionResult = {
          needsModifiers: true,
          product: product.name,
          basePrice: product.price,
          missingGroups: modifierCheck.missingRequired.map((group) => ({
            name: group.name,
            multiSelect: group.multiSelect,
            options: group.options.map((o) => ({
              name: o.name,
              additionalPrice: o.additionalPrice,
            })),
          })),
        };
        break;
      }

      actionResult = await runCheckout({
        businessId,
        customerNumber,
        product,
        amount: product.price + modifierCheck.extraTotal,
        email,
        selectedSize,
        selectedColor,
        selectedModifiers: modifierCheck.selections,
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

      const checkout = await runCheckout({
        businessId,
        customerNumber,
        product,
        amount: agreedPrice,
      });
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
    replyContext = {
      phoneNumberId,
      accessToken,
      customerNumber,
      language: getSession(businessId, customerNumber).language,
    };

    // Acknowledge immediately — shows read ticks and typing indicator while we process
    whatsapp.markMessageAsRead(phoneNumberId, accessToken, messageId);
    whatsapp.sendTypingIndicator(phoneNumberId, accessToken, customerNumber);

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
        t(replyContext.language).notUnderstood,
      );

      return;
    }

    const session = getSession(businessId, customerNumber);

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const absenceMs = session.lastMessageAt
      ? Date.now() - new Date(session.lastMessageAt).getTime()
      : null;

    const isFirstVisit = !session.lastMessageAt;
    const isReturningAfterAbsence = absenceMs !== null && absenceMs > ONE_HOUR_MS;

    let activeSession = session;
    let greetingWasSent = false;

    // The AI-config welcome message is reserved for the very first chat. Any
    // return after an hour+ of silence gets an AI-constructed "welcome back".
    let greeting = null;

    if (isFirstVisit) {
      greeting =
        business.aiConfig?.greetingMessage?.trim() ||
        (await openaiService.generateGreeting("first_visit", business, session.language));
    } else if (isReturningAfterAbsence) {
      greeting = await openaiService.generateGreeting(
        "welcome_back",
        business,
        session.language,
      );
    }

    if (greeting) {
      await whatsapp.sendTextMessage(phoneNumberId, accessToken, customerNumber, greeting);
      await new Promise((r) => setTimeout(r, 600));
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

    let responseText = aiOutput.response;

    if (action.type !== "none") {
      const { actionResult, productsToShow, asPickableCards } = await executeAction({
        action,
        businessId,
        customerNumber,
        session,
      });

      const freshSession = getSession(businessId, customerNumber);

      // The "show more" hint is written in code, never by the model — it must
      // only ever appear when items genuinely remain. When everything left is
      // a lower-tier match, frame it as suggestions instead of more results.
      const remainingCount = actionResult?.remainingCount;
      const moreItemsHint =
        typeof remainingCount === "number" && remainingCount > 0
          ? actionResult?.remainingAreSuggestions
            ? t(language).otherItems(remainingCount)
            : t(language).moreItems(remainingCount)
          : null;

      const sendingCards = asPickableCards && productsToShow.length > 0;

      if (sendingCards) {
        // Search results: the cards ARE the response — image, full details,
        // and the "Pick this one" button — no AI intro bubble before them.
        // The hint about more items goes out after the last card.
        const localizedCards = await localizeProductsForLanguage(
          productsToShow,
          language,
        );

        await whatsapp.sendProductList(
          phoneNumberId,
          accessToken,
          customerNumber,
          localizedCards,
          "",
          moreItemsHint || "",
          language,
        );

        // History note (never sent) so follow-ups like "the second one" or
        // "the jollof" stay grounded in exactly what was shown.
        responseText = `[Sent product cards: ${productsToShow
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

        responseText = finalAiOutput.response;

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
