import mongoose from 'mongoose';

/**
 * Mirror of Velte's ModifierOption model. One option name per vendor — the
 * price lives here and is shared across every product that uses the option.
 * Prices are stored in the smallest unit (kobo), like product prices.
 */
const ModifierOptionSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    name: { type: String, required: true, trim: true },
    additionalPrice: { type: Number, default: 0, min: 0 },
  },
  { collection: 'modifieroptions', timestamps: true },
);

export const ModifierOption =
  mongoose.models.ModifierOption || mongoose.model('ModifierOption', ModifierOptionSchema);
