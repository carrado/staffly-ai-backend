import mongoose from "mongoose";

// Read-only view of velte-backend's PlatformSubscription. Q6: an Enterprise
// vendor does not pay the lead fee, so they stay in search even with a dry
// wallet. This service never writes these rows.
const schema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId },
    ownerType: { type: String },
    plan: { type: String },
    status: { type: String },
    currentPeriodEnd: { type: Date },
  },
  { collection: "platformsubscriptions", strict: false },
);

export default mongoose.model("PlatformSubscriptionRead", schema);
