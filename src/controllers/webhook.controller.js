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

import { getBusinessByPhoneNumberId } from "../models/Business.js";
import {
  getSession,
  setSession,
  setLastProduct,
  clearNegotiation,
} from "../models/ConversationState.js";
import * as whatsapp from "../services/whatsapp.service.js";
import * as openaiService from "../services/openai.service.js";
import * as productService from "../services/product.service.js";
import * as paymentService from "../services/payment.service.js";
import * as emailService from "../services/email.service.js";
import { startNegotiation, updateNegotiation } from "../services/negotiation.service.js";
import { logger } from "../utils/logger.js";

const SEARCH_PAGE_SIZE = 4;
const SEARCH_LIMIT = 50;

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
  };
}

async function sendOutboundMessage({
  phoneNumberId,
  accessToken,
  customerNumber,
  responseText,
  productsToShow = [],
}) {
  if (productsToShow.length === 1) {
    await whatsapp.sendProductCard(
      phoneNumberId,
      accessToken,
      customerNumber,
      productsToShow[0],
      responseText,
    );
    return;
  }

  if (productsToShow.length > 1) {
    await whatsapp.sendProductList(
      phoneNumberId,
      accessToken,
      customerNumber,
      productsToShow,
      responseText,
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

async function extractUserMessage(message, accessToken, business) {
  try {
    if (message.type === "text") {
      return message.text?.body?.trim() || "";
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

  switch (action.type) {
    case "search_products": {
      const query = action.data.query?.trim();

      if (!query) {
        actionResult = createDefaultActionResult(
          "I could not tell what to search for. Please mention the product, category, or what you want to use it for.",
        );
        break;
      }

      const found = await productService.searchProducts(
        businessId,
        query,
        SEARCH_LIMIT,
      );
      const productsToDisplay = found.slice(0, SEARCH_PAGE_SIZE);
      const remainingCount = Math.max(
        found.length - productsToDisplay.length,
        0,
      );

      if (found.length > 0) {
        setLastProduct(businessId, customerNumber, found[0]);
        productsToShow = productsToDisplay;
      }

      const currentSession = getSession(businessId, customerNumber);

      setSession(businessId, customerNumber, {
        ...currentSession,
        lastSearch: {
          query,
          productIds: found.map((product) => product.id),
          offset: productsToDisplay.length,
        },
      });

      actionResult = {
        query,
        count: found.length,
        shownCount: productsToDisplay.length,
        remainingCount,
        products: productsToDisplay.map(mapProductForAI),
      };

      break;
    }

    case "show_more_products": {
      const currentSession = getSession(businessId, customerNumber);
      const lastSearch = currentSession.lastSearch;

      if (!lastSearch?.productIds?.length) {
        actionResult = createDefaultActionResult(
          "There is no previous product search to continue. Please tell me what you are looking for.",
        );
        break;
      }

      const allProducts = await productService.getProductsByIds(lastSearch.productIds);

      const start = lastSearch.offset || 0;
      const nextProducts = allProducts.slice(start, start + SEARCH_PAGE_SIZE);
      const newOffset = start + nextProducts.length;
      const remainingCount = Math.max(allProducts.length - newOffset, 0);

      productsToShow = nextProducts;

      if (nextProducts.length > 0) {
        setLastProduct(businessId, customerNumber, nextProducts[0]);
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
        productsToShow = [product];
        setLastProduct(businessId, customerNumber, product);
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

      productsToShow = [product];
      break;
    }

    case "generate_payment_link": {
      const { email, selectedSize, selectedColor } = action.data;
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

      setLastProduct(businessId, customerNumber, product);

      const { paymentLink, orderId } = paymentService.generatePaymentLink(
        businessId,
        customerNumber,
        product.name,
        product.price,
      );

      await emailService.sendInvoiceEmail(
        email || `${customerNumber}@staffly.app`,
        { product, orderId },
      );

      actionResult = {
        paymentLink,
        orderId,
        product: product.name,
        price: product.price,
        selectedSize: selectedSize || null,
        selectedColor: selectedColor || null,
      };

      productsToShow = [product];
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

      if (!product.allow_negotiation) {
        actionResult = createDefaultActionResult(
          `${product.name} is not available for negotiation.`,
        );
        break;
      }

      const negotiation = startNegotiation(businessId, customerNumber, product);

      actionResult = {
        product: product.name,
        originalPrice: negotiation.originalPrice,
        minPrice: negotiation.minPrice,
        message: "Negotiation started",
      };

      break;
    }

    case "make_offer": {
      const freshSession = getSession(businessId, customerNumber);
      let activeNegotiation = freshSession.negotiation;
      let negotiationProduct = null;

      if (!activeNegotiation && freshSession.lastProduct?.name) {
        const fallbackProduct = await productService.getProductByName(
          businessId,
          freshSession.lastProduct.name,
        );

        if (fallbackProduct?.allow_negotiation) {
          activeNegotiation = startNegotiation(businessId, customerNumber, fallbackProduct);
          negotiationProduct = fallbackProduct;
        }
      }

      if (!activeNegotiation) {
        actionResult = createDefaultActionResult(
          "There is no active negotiation yet. Tell me which product you want to negotiate on.",
        );
        break;
      }

      const updatedNegotiation = updateNegotiation(businessId, customerNumber, action.data.offer);

      if (!negotiationProduct && activeNegotiation.productName) {
        negotiationProduct = await productService.getProductByName(
          businessId,
          activeNegotiation.productName,
        );
      }

      if (negotiationProduct) {
        setLastProduct(businessId, customerNumber, negotiationProduct);
      }

      actionResult = { negotiation: updatedNegotiation };

      break;
    }

    case "accept_offer": {
      const freshSession = getSession(businessId, customerNumber);
      const negotiation = freshSession.negotiation;

      clearNegotiation(businessId, customerNumber);

      let negotiatedProduct = null;

      if (negotiation?.productName) {
        negotiatedProduct = await productService.getProductByName(
          businessId,
          negotiation.productName,
        );
      }

      if (negotiatedProduct) {
        setLastProduct(businessId, customerNumber, negotiatedProduct);
      }
      
      productsToShow = [];

      actionResult = {
        finalPrice: action.data.finalPrice,
        product: negotiation?.productName || null,
        message: "Deal accepted! Proceed to payment.",
      };

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

    case "none":
    default:
      actionResult = null;
      break;
  }

  return { actionResult, productsToShow };
}

export async function handleIncomingMessage(req, res) {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;

    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const customerNumber = message.from;
    const phoneNumberId = value.metadata?.phone_number_id;

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

    const userMessage = await extractUserMessage(message, accessToken, business);

    if (userMessage === "__VOICE_ERROR__") {
      // Generate smart AI fallback message
      const fallback = await openaiService.generateVoiceErrorMessage(business);
    
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
        "Sorry, I could not understand that message. Please send text or a clear voice note.",
      );

      return;
    }

    const session = getSession(businessId, customerNumber);

    // Send greeting on first contact or after 1 hour of inactivity
    const GREETING_COOLDOWN_MS = 60 * 60 * 1000;
    const isFirstMessage = !session.lastMessageAt;
    const isReturningAfterCooldown =
      session.lastMessageAt &&
      Date.now() - new Date(session.lastMessageAt).getTime() > GREETING_COOLDOWN_MS;

    if ((isFirstMessage || isReturningAfterCooldown) && business.aiConfig?.greetingMessage) {
      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        business.aiConfig.greetingMessage,
      );
      await new Promise((r) => setTimeout(r, 600));
    }

    const rawAiOutput = await openaiService.processMessage(
      userMessage,
      session,
      business,
    );

    const aiOutput = openaiService.normalizeAiOutput(rawAiOutput, session);
    const action = aiOutput.action;

    logger.info(`[${business.name}] Normalized action: ${action.type}`);

    let responseText = aiOutput.response;

    if (action.type !== "none") {
      const { actionResult, productsToShow } = await executeAction({
        action,
        businessId,
        customerNumber,
        session,
      });

      const freshSession = getSession(businessId, customerNumber);

      const finalAiOutput =
        await openaiService.generateResponseWithActionResult(
          userMessage,
          freshSession,
          actionResult,
          business,
        );

      responseText = finalAiOutput.response;

      await sendOutboundMessage({
        phoneNumberId,
        accessToken,
        customerNumber,
        responseText,
        productsToShow,
      });
    } else {
      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        responseText,
      );
    }

    const currentSession = getSession(businessId, customerNumber);

    setSession(businessId, customerNumber, {
      conversationHistory: buildConversationHistory(
        currentSession.conversationHistory || [],
        userMessage,
        responseText,
      ),
      lastProduct: currentSession.lastProduct,
      negotiation: currentSession.negotiation,
      lastSearch: currentSession.lastSearch,
      lastMessageAt: new Date(),
    });

    logger.info(`[${business.name}] → replied to ${customerNumber}`);
  } catch (error) {
    logger.error("[Webhook] Unhandled error:", error);
  }
}
