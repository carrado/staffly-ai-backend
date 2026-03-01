import { handlePayment } from '../services/payment.service.js';
import { getOrderById } from '../models/Order.js';
import * as emailService from '../services/email.service.js';
import * as whatsapp from '../services/whatsapp.service.js';
import { getBusinessById } from '../models/Business.js';

export async function handlePaymentWebhook(req, res) {
  try {
    const payload = req.body; // { orderId, status, ... }
    const order = await handlePayment(payload);
    if (order && order.status === 'paid') {
      // Send receipt via email
      await emailService.sendReceiptEmail(`${order.customerNumber}@example.com`, order);

      // Send receipt via WhatsApp
      const business = getBusinessById(order.businessId);
      if (business) {
        const receiptMessage = `✅ Payment received! Your order for ${order.product} is confirmed. Thank you!`;
        await whatsapp.sendTextMessage(business.phone_number_id, business.access_token, order.customerNumber, receiptMessage);
      }
    }
    res.sendStatus(200);
  } catch (error) {
    logger.error('Payment webhook error:', error);
    res.sendStatus(500);
  }
}