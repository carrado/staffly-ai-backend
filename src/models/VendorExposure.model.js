import mongoose from "mongoose";

// Moved here from velte-backend — this collection exists only to support
// retrieval.service.js's result-rotation logic (see its own comment below),
// nothing else in velte-backend ever read or wrote it. Same physical Mongo
// cluster/collection, no data migration needed — just a new owner.
//
// Rolling exposure counter for search-result rotation ("equal share of
// visibility"). One document per (vendor, category, day) rather than one per
// impression — a search that shows a vendor just does a single $inc on
// today's bucket. "Recent exposure" for a vendor is the sum of their
// shownCount across the last EXPOSURE_WINDOW_DAYS bucket documents (see
// fetchRecentExposure in retrieval.service.js).
//
// categoryId is null for service-kind products (they carry no category —
// see Product.model.js) — those fall back to tracking exposure per-vendor
// globally rather than per-category, since there's no category to scope by.
const vendorExposureSchema = new mongoose.Schema({
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  categoryId: { type: String, default: null },
  dateBucket: { type: String, required: true },
  shownCount: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
});

vendorExposureSchema.index(
  { vendorId: 1, categoryId: 1, dateBucket: 1 },
  { unique: true },
);

export default mongoose.model("VendorExposure", vendorExposureSchema);
