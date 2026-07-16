import mongoose from "mongoose";

// Deliberately NOT a full copy of velte-backend's models/Users.js (which
// carries password hashing hooks, auth fields, etc.) — this service only
// ever reads a vendor's geo/trust/display fields for ranking, never writes a
// User doc. A lean, explicit subset pointed at the same "users" collection
// (third mongoose.model() arg) keeps that read-only contract obvious and
// avoids accidentally dragging bcrypt/auth logic into a service that has no
// business touching it. Model name "VendorRead", not "User", so it can never
// be confused with a write-capable model if this repo ever needs one later.
//
// Add fields here if retrieval.service.js starts reading more of the vendor
// doc — but never add write-only concerns (password, emailOtp, etc.).
const vendorReadSchema = new mongoose.Schema(
  {
    name: { type: String },
    phone: { type: String },
    avatar: { type: String },
    area: { type: String },
    state: { type: String },
    trustScore: { type: Number },
    geo: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    company: {
      name: { type: String },
    },
  },
  { collection: "users", strict: false },
);

export default mongoose.model("VendorRead", vendorReadSchema);
