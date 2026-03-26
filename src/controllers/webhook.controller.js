import { getBusinessByPhoneNumberId } from '../models/Business.js';
import { getSession, setSession, setLastProduct, setNegotiation, clearNegotiation } from '../models/ConversationState.js';
import * as whatsapp from '../services/whatsapp.service.js';
import * as openaiService from '../services/openai.service.js';
import * as productService from '../services/product.service.js';
import * as paymentService from '../services/payment.service.js';
import * as emailService from '../services/email.service.js';
import { logger } from '../utils/logger.js';

export async function handleIncomingMessage(req, res) {
  try {
    // --- 1. Extract basic info ---
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return res.sendStatus(200);

    const message = value.messages[0];
    const customerNumber = message.from;
    const phoneNumberId = value.metadata.phone_number_id;

    const business = getBusinessByPhoneNumberId(phoneNumberId);
    if (!business) {
      logger.warn('Business not found for phoneNumberId:', phoneNumberId);
      return res.sendStatus(200);
    }

    const accessToken = business.access_token;

    // --- 2. Extract user message (text or transcribed voice) ---
    let userMessage = '';
    let mediaBuffer = null;
    let isVoice = false;

    if (message.type === 'text') {
      userMessage = message.text.body;
    } else if (message.type === 'voice') {
      isVoice = true;
      const mediaId = message.voice.id;
      mediaBuffer = await whatsapp.downloadMedia(mediaId, accessToken);
      userMessage = await openaiService.transcribeAudio(mediaBuffer);
    } else {
      // Unsupported type – ignore
      return res.sendStatus(200);
    }

    // --- 3. Retrieve current session ---
    const session = getSession(business.id, customerNumber);

    // --- 4. First AI call: get initial intent and maybe an action ---
    let aiOutput = await openaiService.processMessage(userMessage, session);
    logger.info('Initial AI output:', aiOutput);

    let responseText = aiOutput.response;
    let action = aiOutput.action || { type: 'none' };

    // --- 5. If an action is requested, perform it and then ask AI to write the final response ---
    if (action.type !== 'none') {
      // We'll collect data from the action
      let actionResult = null;

      switch (action.type) {
        case 'search_products': {
          const query = action.data.query;
          const products = productService.searchProducts(business.id, query);
          if (products.length > 0) {
            // Store the first match as last product for context
            setLastProduct(business.id, customerNumber, products[0]);
            actionResult = { products };
          } else {
            actionResult = { products: [] };
          }
          break;
        }

        case 'generate_payment_link': {
          const productName = action.data.productName;
          const email = action.data.email; // AI may include email if user provided it
          const product = productService.getProductByName(business.id, productName);
          if (product) {
            const { paymentLink, orderId } = paymentService.generatePaymentLink(
              business.id,
              customerNumber,
              product.name,
              product.price
            );
            // Send invoice email (mock) – you can also send a real PDF
            await emailService.sendInvoiceEmail(email || `${customerNumber}@example.com`, { product, orderId });
            actionResult = { paymentLink, orderId };
          } else {
            actionResult = { error: 'Product not found' };
          }
          break;
        }

        case 'start_negotiation': {
          const productName = action.data.productName;
          const product = productService.getProductByName(business.id, productName);
          if (product && product.allow_negotiation) {
            setNegotiation(business.id, customerNumber, {
              productId: product.id,
              productName: product.name,
              originalPrice: product.price,
              minPrice: product.min_price,
              currentOffer: null,
              stage: 'started',
            });
            actionResult = { product };
          } else {
            actionResult = { error: 'Product not negotiable or not found' };
          }
          break;
        }

        case 'make_offer': {
          const offer = action.data.offer;
          const negotiation = session.negotiation;
          if (negotiation) {
            // Update negotiation with the offer
            setNegotiation(business.id, customerNumber, { ...negotiation, currentOffer: offer, stage: 'offered' });
            // Provide the updated negotiation to the AI
            actionResult = { negotiation: { ...negotiation, currentOffer: offer } };
          } else {
            actionResult = { error: 'No ongoing negotiation' };
          }
          break;
        }

        case 'accept_offer': {
          const finalPrice = action.data.finalPrice;
          clearNegotiation(business.id, customerNumber);
          actionResult = { finalPrice };
          break;
        }

        // Add more action types as needed
        default:
          logger.warn('Unknown action type:', action.type);
      }

      // --- 6. Now that we have actionResult, call AI again to craft the final response ---
      // We pass the original user message, the updated session, and the action result.
      const finalAiOutput = await openaiService.generateResponseWithActionResult(
        userMessage,
        getSession(business.id, customerNumber), // fresh session (updated by actions)
        actionResult
      );
      responseText = finalAiOutput.response;
      logger.info('Final AI output:', finalAiOutput);
    }

    // --- 7. Update conversation history with the final response ---
    const updatedSession = getSession(business.id, customerNumber);
    setSession(business.id, customerNumber, {
      conversationHistory: [
        ...(updatedSession.conversationHistory || []),
        { role: 'user', content: userMessage },
        { role: 'assistant', content: responseText },
      ],
      lastProduct: updatedSession.lastProduct,
      negotiation: updatedSession.negotiation,
    });

    // --- 8. Send the response back to the user ---
    if (isVoice) {
      // For voice messages, respond with audio (simplified: text for now)
      const audioBuffer = await openaiService.textToSpeech(responseText);
      // In a real implementation, you would upload the audio and send via WhatsApp
      await whatsapp.sendTextMessage(phoneNumberId, accessToken, customerNumber, responseText);
    } else {
      await whatsapp.sendTextMessage(phoneNumberId, accessToken, customerNumber, responseText);
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('Webhook error:', error);
    res.sendStatus(500);
  }
}