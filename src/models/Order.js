/**
 * Order Model — Multi-Tenant, Mongo-backed
 *
 * Lightweight checkout records for the WhatsApp payment flow, persisted so they
 * survive restarts: a payment webhook (which can arrive long after a deploy)
 * must still be able to find its order, and the abandoned-checkout follow-up
 * must still be able to tell paid from unpaid.
 *
 * Backed by the dedicated `staffly_orders` collection (see mongoose/StafflyOrder
 * for why this is kept apart from the platform `orders` collection).
 */

import { StafflyOrder } from './mongoose/StafflyOrder.js';

const toOrder = (doc) =>
  doc
    ? {
        id: doc.orderId,
        businessId: doc.businessId,
        customerNumber: doc.customerNumber,
        product: doc.product,
        productId: doc.productId || null,
        productImage: doc.productImage || null,
        amount: doc.amount,
        status: doc.status,
        customerName: doc.customerName || null,
        customerEmail: doc.customerEmail || null,
        location: doc.location || null,
        createdAt: doc.createdAt,
      }
    : null;

export const createOrder = async ({
  businessId,
  customerNumber,
  product,
  productId = null,
  productImage = null,
  amount,
  quantity = 1,
  status = 'pending',
  customerName = null,
  customerEmail = null,
  location = null,
}) => {
  // Random suffix so two links generated in the same millisecond can't collide.
  const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const doc = await StafflyOrder.create({
    orderId,
    businessId,
    customerNumber,
    product,
    productId,
    productImage,
    amount,
    quantity,
    status,
    customerName,
    customerEmail,
    location,
  });
  return toOrder(doc);
};

export const updateOrderStatus = async (orderId, status) => {
  const doc = await StafflyOrder.findOneAndUpdate(
    { orderId },
    { $set: { status } },
    { new: true },
  ).lean();
  return toOrder(doc);
};

export const getOrderById = async (id) => {
  const doc = await StafflyOrder.findOne({ orderId: id }).lean();
  return toOrder(doc);
};

export const getOrdersByBusiness = async (businessId) => {
  const docs = await StafflyOrder.find({ businessId }).sort({ createdAt: -1 }).lean();
  return docs.map(toOrder);
};
