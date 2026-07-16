import webpush from "web-push";
import PushSubscription from "../models/PushSubscription.model.js";
import Notification from "../models/Notification.model.js";

// Mirrors velte-backend/src/services/pushNotification.service.js verbatim
// (same VAPID_* env vars, same behavior) — this repo's only caller is
// retrieval.service.js's expired-listing notify. Duplicated rather than
// called cross-service since it's a low-frequency, non-money side effect;
// see this repo's README.

const MAX_AUTH_FAILURES = 5;

const HIGH_URGENCY_TYPES = new Set(["new-lead", "wallet", "referral", "system"]);
const HIGH_URGENCY_TTL_SECONDS = 60 * 60 * 4;

let pushEnabled = false;
try {
  if (
    !process.env.VAPID_SUBJECT ||
    !process.env.VAPID_PUBLIC_KEY ||
    !process.env.VAPID_PRIVATE_KEY
  ) {
    throw new Error("VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not all set");
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  pushEnabled = true;
} catch (err) {
  console.error(
    `[Push] Web-push disabled — invalid VAPID config: ${err.message}. ` +
      `In-app notifications still work; fix the VAPID_* env vars to enable push.`,
  );
}

/**
 * Send a push notification to all of a user's registered devices. Also
 * saves an in-app notification record.
 */
export async function notifyUser(userId, payload) {
  const {
    title,
    body,
    url = null,
    tag = null,
    icon = "/velte_manifest.png",
    badge = "/velte_manifest.png",
    type = "system",
    requireInteraction = false,
    metadata = null,
  } = payload;

  await Notification.create({ userId, title, body, url, tag, type, metadata });

  if (!pushEnabled) return;

  const subscriptions = await PushSubscription.find({ userId });
  if (!subscriptions.length) {
    console.warn(`[Push] notifyUser(${userId}): no push subscriptions — nothing to deliver`);
    return;
  }

  const pushPayload = JSON.stringify({ title, body, url, tag, icon, badge, requireInteraction });
  const sendOptions = HIGH_URGENCY_TYPES.has(type)
    ? { TTL: HIGH_URGENCY_TTL_SECONDS, urgency: "high" }
    : undefined;
  console.log(`[Push] notifyUser(${userId}): pushing to ${subscriptions.length} subscription(s)`);

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload,
          sendOptions,
        );
        await PushSubscription.updateOne(
          { endpoint: sub.endpoint },
          { $set: { lastSeenAt: new Date(), failureCount: 0 } },
        );
        console.log(`[Push] ✓ delivered to ${sub.endpoint.slice(0, 60)}…`);
      } catch (err) {
        console.error(
          `[Push] ✗ send failed (status ${err.statusCode}) for ${sub.endpoint.slice(0, 60)}…: ${err.body || err.message}`,
        );
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ endpoint: sub.endpoint });
          console.warn(`[Push] removed dead subscription ${sub.endpoint.slice(0, 60)}…`);
        } else if (err.statusCode === 401 || err.statusCode === 403) {
          const updated = await PushSubscription.findOneAndUpdate(
            { endpoint: sub.endpoint },
            { $inc: { failureCount: 1 }, $set: { lastFailureAt: new Date() } },
            { new: true },
          );
          if (updated && updated.failureCount >= MAX_AUTH_FAILURES) {
            await PushSubscription.deleteOne({ endpoint: sub.endpoint });
            console.warn(
              `[Push] removed subscription after ${updated.failureCount} auth failures ${sub.endpoint.slice(0, 60)}…`,
            );
          }
        }
      }
    }),
  );
}
