import mongoose from "mongoose";

// Mirrors velte-backend/src/models/Store.model.js field-for-field. Same
// read-only relationship as Product.model.js in this repo — velte-backend
// owns writes (including `embedding`, populated by its embedding.service.js).

const storeSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    handle: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 600 },
    sectors: { type: [String], default: [] },
    whatsapp: { type: String, default: null },
    gallery: { type: [String], default: [] },
    connectedCatalog: {
      type: new mongoose.Schema(
        {
          sourceUrl: { type: String, required: true },
          platform: {
            type: String,
            enum: ["woocommerce", "shopify", "feed", "unknown"],
            default: "unknown",
          },
          status: {
            type: String,
            enum: ["connected", "review"],
            default: "review",
          },
          productCount: { type: Number, default: 0 },
          connectedAt: { type: Date, default: Date.now },
          lastSyncedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    embedding: { type: [Number], default: undefined, select: false },
  },
  { timestamps: true },
);

export default mongoose.model("Store", storeSchema);
