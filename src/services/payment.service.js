import { createOrder } from '../models/Order.js';
import { env } from '../config/env.js';

/**
 * Generate a payment link for a given business + product.
 * Replace with your real payment gateway (Paystack, Flutterwave, Stripe, etc.)
 */
export async function generatePaymentLink(businessId, customerNumber, productName, amount) {
  const order = await createOrder({ businessId, customerNumber, product: productName, amount });
  const paymentLink = `${env.baseUrl}/pay/${order.id}`;
  return { paymentLink, orderId: order.id };
}
