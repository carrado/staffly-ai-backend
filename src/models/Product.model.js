import mongoose from "mongoose";

// Mirrors velte-backend/src/models/Product.model.js field-for-field — this
// service only ever reads Products ($vectorSearch + candidate mapping), it
// never writes one. velte-backend remains the sole writer (including the
// embedding fields, populated at create/update time by its own
// embedding.service.js). If a field is added/renamed there, mirror it here
// too — see README's "keeping schemas in sync" note.

const attributeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: true },
);

const modifierGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    required: { type: Boolean, default: false },
    multiSelect: { type: Boolean, default: false },
    options: [{ type: mongoose.Schema.Types.ObjectId, ref: "ModifierOption" }],
  },
  { _id: true },
);

const productSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    businessType: {
      type: String,
      enum: ["retail", "food", "service", "both", "food_both"],
      required: true,
    },
    kind: { type: String, enum: ["product", "service"], default: "product" },
    quoteOnRequest: { type: Boolean, default: false },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 1000, default: null },
    categoryId: {
      type: String,
      default: null,
      required: function () {
        return this.kind !== "service";
      },
    },
    price: { type: Number, required: true, min: 0 },
    priceMax: { type: Number, default: null, min: 0 },
    currency: { type: String, enum: ["NGN", "USD"], default: "NGN" },
    isFeatured: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    mainImageUrl: { type: String, default: null },
    thumbnailUrls: { type: [String], default: [] },
    videoUrl: { type: String, default: null },
    colorClass: { type: String, default: null },

    manufacturingDate: { type: Date, default: null },
    expirationDate: { type: Date, default: null },
    attributes: { type: [attributeSchema], default: [] },

    estimatedPrepMins: { type: Number, default: null },
    isCurrentlyAvailable: { type: Boolean, default: true },
    dailyLimit: { type: Number, default: null },
    dailyOrderCount: { type: Number, default: 0 },
    dailyLimitDisabled: { type: Boolean, default: false },
    allowPreOrder: { type: Boolean, default: false },
    modifiers: { type: [modifierGroupSchema], default: [] },

    origin: {
      type: String,
      enum: ["manual", "connected"],
      default: "manual",
    },
    sourceUrl: { type: String, default: null },
    externalId: { type: String, default: null },
    syncedAt: { type: Date, default: null },

    embedding: { type: [Number], default: undefined, select: false },
    imageEmbedding: { type: [Number], default: undefined, select: false },
  },
  {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  },
);

export default mongoose.model("Product", productSchema);
