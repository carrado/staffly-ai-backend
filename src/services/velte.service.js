import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Bridge a placed/paid manual-transfer order into velte so it shows in the
 * merchant's dashboard. Mirrors velte's own dispatchToStaffly (reverse direction):
 * signs the RAW body with the shared VELTE_WEBHOOK_SECRET (HMAC-SHA256) and sends
 * it as `x-staffly-signature`. Best-effort — a bridge failure must never break the
 * customer reply (the StafflyOrder is already the source of truth) — but it is
 * logged LOUDLY (with the velte status + response body) and retried once on a
 * transient failure, so a silently-dropped order is diagnosable instead of lost.
 *
 * @param {object} payload - { stafflyOrderId, merchantId (velteUserId),
 *   paymentStatus: 'paid' | 'awaiting_confirmation', product, amount, quantity,
 *   items, customerName, customerPhone, customerEmail, deliveryAddress, productImage }
 * @returns {Promise<boolean>} true if velte accepted the order, false otherwise.
 */
export async function notifyVelteOrder(payload) {
  const base = env.velteApiUrl;
  const secret = env.velteWebhookSecret;
  if (!base || !secret) {
    logger.error(
      `[VelteBridge] VELTE_API_URL or VELTE_WEBHOOK_SECRET not set — order ${payload?.stafflyOrderId} NOT bridged to velte. Set both env vars and restart.`,
    );
    return false;
  }

  const url = `${base.replace(/\/$/, "")}/internal/orders/from-staffly`;
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  // One retry: covers a velte restart / transient network blip between attempts.
  // A 4xx (bad signature, validation) won't fix itself, so don't retry those.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Send the exact bytes we signed so velte's HMAC over the raw body matches.
      await axios.post(url, body, {
        headers: {
          "x-staffly-signature": signature,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      });
      return true;
    } catch (err) {
      const status = err.response?.status;
      const respBody = err.response?.data;
      const detail = status
        ? `velte responded ${status} ${JSON.stringify(respBody)}`
        : err.message; // no response = network error / velte down (ECONNREFUSED, timeout)
      const retriable = !status || status >= 500; // network or velte 5xx only
      const willRetry = retriable && attempt < MAX_ATTEMPTS;

      logger.error(
        `[VelteBridge] Failed to bridge order ${payload?.stafflyOrderId} to velte ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS}) → POST ${url}: ${detail}` +
          (willRetry ? " — retrying…" : ""),
      );

      if (!willRetry) return false;
    }
  }
  return false;
}
