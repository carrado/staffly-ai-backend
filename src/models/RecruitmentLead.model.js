import mongoose from "mongoose";

// Moved here from velte-backend, verbatim — populated only by this repo's
// search.controller.js logSearch. A real, non-Velte business surfaced by
// searchStores' Google Places fallback tier — recruitment target data, not
// a demand-log row. `placeId` (Google's stable Place ID) is the dedupe key:
// the same real business legitimately recurs across many unrelated buyer
// turns, so it needs its own identity with a hit count, not a repeated blob
// per search.
//
// Instagram leads (velte frontend, 2026-09-16) share this collection rather
// than getting their own: a recruiter working the list wants ONE queue of
// unlisted businesses buyers keep asking for, whichever tier found them.
// They carry no Google Place ID, no address and no coordinates, so:
//   - `placeId` stays the unique dedupe key, as `instagram:<handle>` — a
//     synthetic id in the same slot, so the existing unique index does the
//     dedupe for both kinds without a second index or a schema rename.
//   - `address`/`location` become optional. `location` in particular is a
//     sub-schema with NO default: a bare `{ type: "Point" }` with no
//     coordinates would be rejected by the 2dsphere index, so an Instagram
//     row must simply not have the field at all.
//   - `buyerReachOuts` is the signal Places rows never had: not "this
//     business was SHOWN to a buyer" (that's hitCount) but "a buyer actually
//     tapped Message and was handed a Velte intro to send" — the strongest
//     recruitment lead there is, since the business has just been told
//     about Velte by a real customer.

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  { _id: false },
);

const recruitmentLeadSchema = new mongoose.Schema(
  {
    placeId: { type: String, required: true, unique: true },
    source: { type: String, enum: ["places", "instagram"], default: "places" },
    name: { type: String, required: true },
    address: { type: String, default: null },
    location: { type: pointSchema, default: undefined },
    // Instagram-only.
    instagramHandle: { type: String, default: null },
    profileUrl: { type: String, default: null },
    matchedQueries: { type: [String], default: [] },
    hitCount: { type: Number, default: 0 },
    buyerReachOuts: { type: Number, default: 0 },
    lastReachOutAt: { type: Date, default: null },
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
recruitmentLeadSchema.index({ source: 1, buyerReachOuts: -1 });

export default mongoose.model("RecruitmentLead", recruitmentLeadSchema);
