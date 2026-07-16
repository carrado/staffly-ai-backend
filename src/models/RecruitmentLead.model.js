import mongoose from "mongoose";

// Moved here from velte-backend, verbatim — populated only by this repo's
// search.controller.js logSearch. A real, non-Velte business surfaced by
// searchStores' Google Places fallback tier — recruitment target data, not
// a demand-log row. `placeId` (Google's stable Place ID) is the dedupe key:
// the same real business legitimately recurs across many unrelated buyer
// turns, so it needs its own identity with a hit count, not a repeated blob
// per search.
const recruitmentLeadSchema = new mongoose.Schema(
  {
    placeId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    matchedQueries: { type: [String], default: [] },
    hitCount: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["new", "contacted", "onboarded", "ignored"],
      default: "new",
    },
  },
  { timestamps: true },
);

recruitmentLeadSchema.index({ location: "2dsphere" });

export default mongoose.model("RecruitmentLead", recruitmentLeadSchema);
