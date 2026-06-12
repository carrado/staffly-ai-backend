import mongoose from 'mongoose';

// Mirror of velte-backend's PaymentLink model (collection: paymentlinks).
// Staffly reads these to hand a customer the merchant's payment link.
const PaymentLinkSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    linkId: { type: String, unique: true },
    url: String,
    bankCode: String,
    bankName: String,
    accountNumber: String,
    accountName: String,
    subaccountCode: { type: String, default: null },
    paystackSubaccountId: { type: String, default: null },
    amount: { type: Number, default: null }, // null = open amount
    description: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    clickCount: { type: Number, default: 0 },
  },
  { collection: 'paymentlinks', timestamps: true },
);

export const PaymentLink =
  mongoose.models.PaymentLink || mongoose.model('PaymentLink', PaymentLinkSchema);
