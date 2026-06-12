import mongoose from 'mongoose';

const ProductSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    businessType: String,
    name: { type: String, required: true },
    description: String,
    categoryId: String,
    price: Number,
    currency: { type: String, default: 'NGN' },
    discountedPrice: Number,
    isNegotiable: { type: Boolean, default: false },
    minimumPrice: Number,
    isFeatured: Boolean,
    tags: [String],
    mainImageUrl: String,
    thumbnailUrls: [String],
    attributes: [{ name: String, value: String }],

    // retail
    stockQuantity: Number,
    orderedQuantity: Number,
    lowStockThreshold: Number,
    manufacturingDate: Date,
    expirationDate: Date,

    // food
    estimatedPrepMins: Number,
    isCurrentlyAvailable: { type: Boolean, default: true },
    dailyLimit: Number,
    dailyOrderCount: Number,
    dailyLimitDisabled: { type: Boolean, default: false },
    allowPreOrder: { type: Boolean, default: false },
    // Modifier groups are embedded per product; options are refs to the
    // shared ModifierOption collection (price lives there).
    modifiers: [
      {
        name: String,
        required: { type: Boolean, default: false },
        multiSelect: { type: Boolean, default: false },
        options: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ModifierOption' }],
      },
    ],
  },
  { collection: 'products', timestamps: true },
);

export const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
