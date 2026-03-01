import { createOrder as createOrderModel, updateOrderStatus } from '../models/Order.js';

export function createOrder(businessId, customerNumber, product, amount) {
  return createOrderModel({ businessId, customerNumber, product, amount, status: 'pending' });
}

export function markOrderPaid(orderId) {
  updateOrderStatus(orderId, 'paid');
}