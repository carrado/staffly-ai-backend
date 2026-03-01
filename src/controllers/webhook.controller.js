import { getBusinessByPhoneNumberId } from '../models/Business.js';
import { getSession, setSession } from '../models/ConversationState.js';
import * as whatsapp from '../services/whatsapp.service.js';
import * as openaiService from '../services/openai.service.js';
import * as productService from '../services/product.service.js';
import * as negotiationService from '../services/negotiation.service.js';
import * as paymentService from '../services/payment.service.js';
import * as emailService from '../services/email.service.js';
import { logger } from '../utils/logger.js';

export async function handleIncomingMessage(req, res) {
  try {
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

    // Ensure token is valid (refresh logic can be added)
    const accessToken = business.access_token;

    let userMessage = '';
    let mediaBuffer = null;

    // Handle different message types
    if (message.type === 'text') {
      userMessage = message.text.body;
    } else if (message.type === 'voice') {
      const mediaId = message.voice.id;
      mediaBuffer = await whatsapp.downloadMedia(mediaId, accessToken);
      userMessage = await openaiService.transcribeAudio(mediaBuffer);
    } else {
      // Unsupported type
      return res.sendStatus(200);
    }

    // Detect intent
    const intent = await openaiService.detectIntent(userMessage);
    logger.info(`Intent detected: ${intent.type}`);

    let responseText = '';
    let imageUrl = null;
    let audioBuffer = null;

    // Retrieve conversation state
    const session = getSession(business.id, customerNumber);

    switch (intent.type) {
      case 'greeting':
        responseText = 'Hello 👋 Welcome! How can I help you today?';
        break;

      case 'inquiry': {
        const products = productService.searchProducts(business.id, intent.query || userMessage);
        logger.info('products:', products.length);
        if (products.length === 0) {
          // Suggest alternatives
          const suggestions = await productService.suggestProducts(business.id, userMessage);
          if (suggestions.length > 0) {
            responseText = `We don't have "${intent.query}" but you might like:\n`;
            suggestions.forEach(p => {
              responseText += `• ${p.name} – ₦${p.price}\n`;
            });
          } else {
            responseText = "Sorry, we don't have that product.";
          }
        } else {
          const product = products[0];
          responseText = `Yes ✅ We have ${product.name} (Size ${product.size}) for ₦${product.price}. Would you like to buy?`;
          imageUrl = product.image_url;
        }
        break;
      }

      case 'order': {
        const product = productService.getProductByName(business.id, intent.productName);
        if (!product) {
          responseText = "Product not found. Please check the name.";
          break;
        }
        if (product.stock <= 0) {
          responseText = "Sorry, that product is out of stock.";
          break;
        }
        // Create order and payment link
        const { paymentLink, orderId } = paymentService.generatePaymentLink(
          business.id,
          customerNumber,
          product.name,
          product.price
        );
        responseText = `Great! Here's your payment link:\n${paymentLink}\nAmount: ₦${product.price}`;
        // Send invoice email (mock)
        await emailService.sendInvoiceEmail(`${customerNumber}@example.com`, { product, orderId });
        break;
      }

      case 'negotiate': {
        const product = productService.getProductByName(business.id, intent.productName);
        if (!product || !product.allow_negotiation) {
          responseText = "This product is not negotiable.";
          break;
        }
        const offer = intent.offer;
        if (!offer) {
          // Start negotiation
          negotiationService.startNegotiation(business.id, customerNumber, product);
          responseText = `You can make an offer for ${product.name} (original price ₦${product.price}). What is your offer?`;
        } else {
          const negotiation = negotiationService.updateNegotiation(business.id, customerNumber, offer);
          if (!negotiation) {
            responseText = "Let's start over. What product would you like to negotiate?";
            break;
          }
          if (negotiationService.isAccepted(product.price, product.min_price, offer)) {
            responseText = `Deal accepted! Final price: ₦${offer}. Shall I generate a payment link?`;
            // Optionally auto-create order
          } else {
            const counter = negotiationService.calculateCounter(product.price, product.min_price);
            responseText = `We can offer ₦${counter}. Is that acceptable?`;
          }
        }
        break;
      }

      case 'chat':
      default:
        // Let OpenAI respond naturally
        responseText = await openaiService.generateChatResponse(session.conversationHistory || [], userMessage);
        // Update conversation history
        setSession(business.id, customerNumber, {
          conversationHistory: [
            ...(session.conversationHistory || []),
            { role: 'user', content: userMessage },
            { role: 'assistant', content: responseText },
          ],
        });
        break;
    }

    // Send response (text, image, or audio)
    if (mediaBuffer && intent.type === 'voice') {
      // Respond with voice if original was voice
      audioBuffer = await openaiService.textToSpeech(responseText);
      // Upload to WhatsApp (simplified: we'd need to upload media first, then send)
      // For mock, send as text
      await whatsapp.sendTextMessage(phoneNumberId, accessToken, customerNumber, responseText);
    } else if (imageUrl) {
      await whatsapp.sendImageMessage(phoneNumberId, accessToken, customerNumber, imageUrl, responseText);
    } else {
      await whatsapp.sendTextMessage(phoneNumberId, accessToken, customerNumber, responseText);
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('Webhook error:', error);
    res.sendStatus(500);
  }
}