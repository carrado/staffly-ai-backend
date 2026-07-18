import mongoose from "mongoose";

// Mirrors velte-backend/src/models/Notification.model.js verbatim, pointed
// at the same "notifications" collection — this repo WRITES to it (only
// from retrieval.service.js's expired-listing notify), velte-backend's own
// dashboard (bell UI) is what reads/displays it. A shared outbox collection,
// not a domain velte-backend needs to keep this repo away from.
const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: {
      type: String,
      enum: [
        "new-order",
        "new-message",
        "new-lead",
        "expired-product",
        "payment",
        "wallet",
        "referral",
        "system",
      ],
      default: "system",
    },
    url: { type: String, default: null },
    tag: { type: String, default: null },
    isRead: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });

export default mongoose.model("Notification", notificationSchema);
