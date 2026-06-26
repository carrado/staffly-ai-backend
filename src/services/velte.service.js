import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Bridge a placed/paid manual-transfer order into velte so it shows in the
 * merchant's dashboard. Mirrors velte's own dispatchToStaffly (reverse direction):
 * signs the RAW body with the shared VELTE_WEBHOOK_SECRET (HMAC-SHA256) and sends
 * it as `x-staffly-signature`. Fire-and-forget — a bridge failure must never break
 * the customer reply (the StafflyOrder is already the source of truth).
 *
 * @param {object} payload - { stafflyOrderId, merchantId (velteUserId),
 *   paymentStatus: 'paid' | 'awaiting_confirmation', product, amount, quantity,
 *   items, customerName, customerPhone, customerEmail, deliveryAddress, productImage }
 */
export async function notifyVelteOrder(payload) {
  const base = env.velteApiUrl;
  const secret = env.velteWebhookSecret;
  if (!base || !secret) {
    logger.warn(
      "[VelteBridge] VELTE_API_URL or VELTE_WEBHOOK_SECRET not set — order not bridged to velte.",
    );
    return;
  }

  const url = `${base.replace(/\/$/, "")}/internal/orders/from-staffly`;
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  try {
    // Send the exact bytes we signed so velte's HMAC over the raw body matches.
    await axios.post(url, body, {
      headers: {
        "x-staffly-signature": signature,
        "Content-Type": "application/json",
      },
      timeout: 5000,
    });
  } catch (err) {
    logger.error(
      `[VelteBridge] Failed to bridge order ${payload?.stafflyOrderId} to velte: ${err.message}`,
    );
  }
}
