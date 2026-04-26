import { updateOrderStatus, getOrderById } from '../models/Order.js';
import { getBusinessById } from '../models/Business.js';
import * as whatsapp from '../services/whatsapp.service.js';
import { logger } from '../utils/logger.js';

/**
 * Mock payment webhook — simulates a payment gateway callback.
 * Replace with your real gateway's webhook (Paystack, Flutterwave, Stripe).
 */
export async function handlePaymentWebhook(req, res) {
  try {
    const { orderId, status } = req.body;
    if (!orderId || !status) return res.status(400).json({ error: 'Missing orderId or status' });

    const order = getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    updateOrderStatus(orderId, status);

    // Notify the customer via WhatsApp
    if (status === 'paid') {
      const business = getBusinessById(order.businessId);
      if (business) {
        const msg = `✅ Payment confirmed! Your order for *${order.product}* has been received. Thank you for shopping with ${business.name}!`;
        await whatsapp.sendTextMessage(
          business.phone_number_id,
          business.access_token,
          order.customerNumber,
          msg
        );
      }
    }

    logger.info(`Payment webhook: order ${orderId} → ${status}`);
    return res.json({ success: true });
  } catch (error) {
    logger.error('Payment webhook error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
