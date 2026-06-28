import mongoose from 'mongoose';

/**
 * Persisted visual embedding of a product's photo (Voyage voyage-multimodal-3),
 * the durable backing store for the in-memory embedding cache in
 * `services/product.service.js`. One document per `businessId:productId`.
 *
 * Embeddings cost money to compute, so they're persisted here to survive
 * restarts/deploys rather than re-embedding the catalogue each boot. `imageUrl`
 * is the photo the vector was computed from: a product whose image changes no
 * longer matches its stored `imageUrl`, so the reader treats it as stale and
 * re-embeds — no change-stream wiring needed for correctness.
 */
const ProductEmbeddingSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true },
    productId: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    embedding: { type: [Number], default: [] },
  },
  { collection: 'productembeddings', timestamps: true, minimize: false },
);

ProductEmbeddingSchema.index({ businessId: 1, productId: 1 }, { unique: true });

export const ProductEmbedding =
  mongoose.models.ProductEmbedding ||
  mongoose.model('ProductEmbedding', ProductEmbeddingSchema);
