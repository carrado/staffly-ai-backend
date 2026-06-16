import mongoose from 'mongoose';

/**
 * StafflyOrder — the durable backing store for the lightweight checkout records
 * in `models/Order.js` (created when a WhatsApp payment link is generated,
 * flipped to "paid" by the payment webhook).
 *
 * Deliberately SEPARATE from the platform `Order` model (mongoose/Order.js, the
 * shared velte-backend `orders` collection). That collection is the merchant's
 * real fulfilment order book with its own status enum; a payment link that was
 * sent but not yet paid is a checkout *intent*, not a fulfilment order, so it
 * lives in its own collection and never pollutes the real one.
 *
 * `orderId` is the public id used in the payment link path and referenced by
 * `session.pendingFollowUp.orderId`.
 */
const StafflyOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    businessId: { type: String, required: true, index: true },
    customerNumber: { type: String, required: true },
    product: { type: String },
    amount: { type: Number },
    status: { type: String, default: 'pending' }, // pending | paid | failed
    // Buyer details gathered during the WhatsApp checkout, used to fulfil the
    // order (name on the order, receipt email, delivery location).
    customerName: { type: String, default: null },
    customerEmail: { type: String, default: null },
    location: { type: String, default: null },
  },
  { collection: 'staffly_orders', timestamps: true },
);

export const StafflyOrder =
  mongoose.models.StafflyOrder || mongoose.model('StafflyOrder', StafflyOrderSchema);
