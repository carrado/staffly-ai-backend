import mongoose from 'mongoose';

// Mirror of velte-backend's Order model (collection: orders).
// Staffly creates orders here when a customer confirms a purchase over WhatsApp.

const chosenModifierSchema = new mongoose.Schema(
  {
    modifierName: { type: String, required: true },
    optionName: { type: String, required: true },
    additionalPrice: { type: Number, default: 0 },
  },
  { _id: false },
);

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    basePrice: { type: Number, required: true },
    chosenModifiers: { type: [chosenModifierSchema], default: [] },
    lineTotal: { type: Number, required: true },
  },
  { _id: false },
);

const OrderSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: String, unique: true, sparse: true },
    status: {
      type: String,
      enum: ['Pending', 'Shipped', 'Delivered', 'Cancelled', 'Preparing', 'Ready', 'OnTheWay'],
      default: 'Pending',
    },
    items: { type: [orderItemSchema], default: [] },
    amount: { type: Number, default: 0 },
    customerName: { type: String, default: null },
    customerPhone: { type: String, default: null },
    customerBank: {
      accountName: { type: String, default: null },
      accountNumber: { type: String, default: null },
      bankCode: { type: String, default: null },
      bankName: { type: String, default: null },
    },
    notes: { type: String, default: null },
  },
  { collection: 'orders', timestamps: true },
);

export const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
