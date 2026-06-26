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

import { StafflyOrder } from "./mongoose/StafflyOrder.js";

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
        quantity: doc.quantity ?? 1,
        items: Array.isArray(doc.items) ? doc.items : [],
        status: doc.status,
        customerName: doc.customerName || null,
        customerEmail: doc.customerEmail || null,
        location: doc.location || null,
        receiptReference: doc.receiptReference || null,
        receiptClaim: doc.receiptClaim || null,
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
  items = [],
  status = "pending",
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
    items,
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
  const docs = await StafflyOrder.find({ businessId })
    .sort({ createdAt: -1 })
    .lean();
  return docs.map(toOrder);
};

// The customer's most recent order still awaiting payment — used to attribute an
// uploaded receipt to the right order.
export const getLatestUnpaidOrder = async (businessId, customerNumber) => {
  const doc = await StafflyOrder.findOne({
    businessId,
    customerNumber,
    status: { $ne: "paid" },
  })
    .sort({ createdAt: -1 })
    .lean();
  return toOrder(doc);
};

// Whether a receipt reference has already paid an order for this business (dedupe:
// the same receipt must not settle two orders).
export const isReceiptUsed = async (businessId, receiptReference) => {
  if (!receiptReference) return false;
  const existing = await StafflyOrder.exists({ businessId, receiptReference });
  return !!existing;
};

// Mark an order paid after its uploaded receipt was verified.
export const markOrderPaid = async (
  orderId,
  { receiptReference = null, verifiedBy = "ai" } = {},
) => {
  const doc = await StafflyOrder.findOneAndUpdate(
    { orderId },
    {
      $set: {
        status: "paid",
        paidAt: new Date(),
        paymentVerifiedBy: verifiedBy,
        receiptReference,
      },
    },
    { new: true },
  ).lean();
  return toOrder(doc);
};

// A receipt verified but NOT auto-confirmed (high-value / new buyer) — held for the
// vendor to confirm. The reference is still stored so it can't be reused (dedupe),
// and the order stays "unpaid" until the vendor approves it. `receiptClaim` is a
// snapshot (image id + what the pipeline read) the vendor reviews in the dashboard.
export const markOrderPaymentClaimed = async (
  orderId,
  { receiptReference = null, receiptClaim = null } = {},
) => {
  const doc = await StafflyOrder.findOneAndUpdate(
    { orderId },
    {
      $set: {
        status: "payment_claimed",
        receiptReference,
        receiptClaim: receiptClaim
          ? { ...receiptClaim, claimedAt: new Date() }
          : null,
      },
    },
    { new: true },
  ).lean();
  return toOrder(doc);
};

// The vendor reviewed a held receipt in the dashboard and REJECTED it (no matching
// credit in their bank). Return the order to "pending" so it's unpaid again and the
// buyer can re-upload — but KEEP receiptReference so that exact receipt can't be
// re-claimed (dedupe). Only acts on an order that is actually awaiting confirmation.
export const rejectOrderPaymentClaim = async (orderId) => {
  const doc = await StafflyOrder.findOneAndUpdate(
    { orderId, status: "payment_claimed" },
    { $set: { status: "pending", paymentVerifiedBy: null } },
    { new: true },
  ).lean();
  return toOrder(doc);
};

// All of a business's receipts currently held for vendor confirmation — the queue
// the velte dashboard renders. Oldest first (FIFO: confirm the longest-waiting buyer
// first).
export const getPendingConfirmations = async (businessId) => {
  const docs = await StafflyOrder.find({
    businessId,
    status: "payment_claimed",
  })
    .sort({ updatedAt: 1 })
    .lean();
  return docs.map(toOrder);
};

// Whether this customer has a PRIOR confirmed-paid order with the business — used
// to treat first-time buyers as higher-risk (route their receipts to the vendor).
export const hasPriorPaidOrder = async (businessId, customerNumber) => {
  const existing = await StafflyOrder.exists({
    businessId,
    customerNumber,
    status: "paid",
  });
  return !!existing;
};
