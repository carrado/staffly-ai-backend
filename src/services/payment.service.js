import { env } from '../config/env.js';
import { createOrder } from '../models/Order.js';
import { getProductByName } from './product.service.js';

export function generatePaymentLink(businessId, customerNumber, productName, amount) {
  // In production, create a real payment session with Paystack/Stripe
  const order = createOrder({
    businessId,
    customerNumber,
    product: productName,
    amount,
    status: 'pending',
  });

  // Return a mock link with order ID
  return {
    paymentLink: `${env.baseUrl}/pay/${order.id}`,
    orderId: order.id,
  };
}

export async function handlePayment(payload) {
  // Mock: assume payment successful
  const { orderId } = payload;
  const order = getOrderById(orderId);
  if (order) {
    order.status = 'paid';
    // Trigger receipt generation
    return order;
  }
  return null;
}