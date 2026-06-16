import mongoose from 'mongoose';

// Mirror of velte-backend's Product model (collection: products). Staffly only
// READS these documents; the Velte platform owns all writes. Kept field-for-field
// in sync with velte so the mapper in product.service.js sees everything.

export const FOOD_CATEGORIES = [
  'rice', 'soups', 'swallow', 'grilled', 'protein',
  'snacks', 'drinks', 'breakfast', 'desserts', 'party',
];

const attributeSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: true }
);

// Each modifier group is embedded per product (required/multiSelect may differ
// per dish), but its options are refs to the shared ModifierOption collection
// so that prices stay centralised across every product that uses the same option.
const modifierGroupSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true },
    required:    { type: Boolean, default: false },
    multiSelect: { type: Boolean, default: false },
    options:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'ModifierOption' }],
  },
  { _id: true }
);

const ProductSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    businessType: { type: String, enum: ['retail', 'food'], required: true },

    // ── shared fields ───────────────────────────────────────────────────────
    name:           { type: String, required: true, trim: true, maxlength: 120 },
    description:    { type: String, maxlength: 1000, default: null },
    categoryId:     { type: String, required: true },
    price:          { type: Number, required: true, min: 0 },
    currency:       { type: String, enum: ['NGN', 'USD'], default: 'NGN' },
    discountedPrice:{ type: Number, default: null },
    taxIncluded:    { type: Boolean, default: false },
    taxType:        { type: String, default: null },   // 'percentage' | 'fixed'
    taxValue:       { type: Number, default: null },
    isNegotiable:   { type: Boolean, default: false },
    minimumPrice:   { type: Number, default: null },
    isFeatured:     { type: Boolean, default: false },
    tags:           { type: [String], default: [] },
    mainImageUrl:   { type: String, default: null },
    thumbnailUrls:  { type: [String], default: [] },
    videoUrl:       { type: String, default: null },
    colorClass:     { type: String, default: null },

    // ── retail-only ─────────────────────────────────────────────────────────
    stockQuantity:     { type: Number, default: 0 },
    orderedQuantity:   { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: null },
    manufacturingDate: { type: Date, default: null },
    expirationDate:    { type: Date, default: null },
    attributes:        { type: [attributeSchema], default: [] },

    // ── food-only ───────────────────────────────────────────────────────────
    estimatedPrepMins:    { type: Number, default: null },
    isCurrentlyAvailable: { type: Boolean, default: true },
    dailyLimit:           { type: Number, default: null },
    dailyOrderCount:      { type: Number, default: 0 },
    dailyLimitDisabled:   { type: Boolean, default: false },
    allowPreOrder:        { type: Boolean, default: false },
    modifiers:            { type: [modifierGroupSchema], default: [] },
  },
  {
    collection: 'products',
    timestamps: true,
    toObject: { virtuals: true },
    toJSON:   { virtuals: true },
  }
);

ProductSchema.virtual('onSale').get(function () {
  if (this.discountedPrice == null) return false;
  if (this.businessType === 'retail') return this.stockQuantity > 0;
  if (this.businessType === 'food')   return this.isCurrentlyAvailable === true;
  return false;
});

export const Product =
  mongoose.models.Product || mongoose.model('Product', ProductSchema);
