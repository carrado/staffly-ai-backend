import mongoose from "mongoose";

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
    // The underlying product so velte can snapshot its photo onto the real order.
    // `product` above stays the human label (incl. chosen variants/modifiers).
    productId: { type: String, default: null },
    productImage: { type: String, default: null }, // Product.mainImageUrl at checkout
    amount: { type: Number }, // grand total = Σ line totals
    quantity: { type: Number, default: 1, min: 1 }, // total units = Σ line quantities
    // Per-variant breakdown of the order. One entry for a plain order; several for
    // a multi-variant order (e.g. 3 red + 1 black). Stored loosely (no _id) since
    // it's a snapshot the pay page and fulfilment order read back.
    items: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String }, // display label, e.g. "T-Shirt (Red)"
            variant: { type: String, default: null }, // "Red, L" (null = no variant)
            quantity: { type: Number, default: 1, min: 1 },
            unitPrice: { type: Number }, // per-unit price incl. modifier add-ons
            lineTotal: { type: Number }, // unitPrice × quantity
            attributes: [{ name: String, value: String, _id: false }],
            modifiers: [
              {
                group: String,
                name: String,
                additionalPrice: Number,
                _id: false,
              },
            ],
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, default: "pending" }, // pending | paid | failed
    // Buyer details gathered during the WhatsApp checkout, used to fulfil the
    // order (name on the order, receipt email, delivery location).
    customerName: { type: String, default: null },
    customerEmail: { type: String, default: null },
    location: { type: String, default: null },
  },
  { collection: "staffly_orders", timestamps: true },
);

export const StafflyOrder =
  mongoose.models.StafflyOrder ||
  mongoose.model("StafflyOrder", StafflyOrderSchema);
