import mongoose from "mongoose";

// Mirrors velte-backend/src/models/PushSubscription.model.js verbatim,
// pointed at the same collection — needed here only so this repo's own copy
// of pushNotification.service.js can deliver the expired-listing notify.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    endpoint: { type: String, required: true, unique: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    failureCount: { type: Number, default: 0 },
    lastFailureAt: { type: Date },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export default mongoose.model("PushSubscription", pushSubscriptionSchema);
