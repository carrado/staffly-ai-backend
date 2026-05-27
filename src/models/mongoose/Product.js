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
    lowStockThreshold: Number,

    // food
    estimatedPrepMins: Number,
    isCurrentlyAvailable: { type: Boolean, default: true },
    dailyLimit: Number,
    dailyOrderCount: Number,
  },
  { collection: 'products', timestamps: true },
);

export const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
