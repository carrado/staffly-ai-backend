import {
  getOrderById,
  getPendingConfirmations,
  markOrderPaid,
  rejectOrderPaymentClaim,
} from "../models/Order.js";
import {
  getBusinessById,
  getBusinessByVelteUserId,
} from "../models/Business.js";
import { cancelFollowUpForOrder } from "../models/ConversationState.js";
import * as whatsapp from "../services/whatsapp.service.js";
import * as velteService from "../services/velte.service.js";
import { logger } from "../utils/logger.js";

/**
 * Vendor payment confirmation — the dashboard side of the manual-transfer flow.
 *
 * A WhatsApp number on the Meta Cloud API is the storefront line (API-only, no
 * human inbox), so the vendor can't be prompted there. Instead, receipts the AI
 * holds for human review (high-value / new-buyer — status "payment_claimed") are
 * surfaced in the merchant's velte dashboard, where the vendor checks them against
 * their bank credit alert and confirms or rejects.
 *
 * These endpoints are called server-to-server by velte-backend and signature-
 * verified (verifyVelteSignature) exactly like the inbound velte webhook. All are
 * POST so the signed raw body is always present.
 *
 *   POST /api/velte/pending-confirmations  { merchantId }                → queue
 *   POST /api/velte/confirm-payment        { stafflyOrderId, decision }  → resolve
 *   POST /api/velte/receipt-image          { stafflyOrderId }            → image
 *
 * `merchantId` is the velte user id (Business.velteUserId).
 */

// Shape a held order for the dashboard queue. Never leak the raw mediaId path or
// access tokens — the vendor fetches the image via /receipt-image instead.
const toQueueItem = (order) => ({
  stafflyOrderId: order.id,
  product: order.product,
  productImage: order.productImage,
  amount: order.amount,
  quantity: order.quantity,
  items: order.items,
  customerName: order.customerName,
  customerPhone: order.customerNumber,
  customerEmail: order.customerEmail,
  deliveryAddress: order.location,
  receiptReference: order.receiptReference,
  // What the OCR/vision pipeline read off the receipt — lets the vendor sanity-
  // check the figures at a glance before opening the image.
  extractedAmount: order.receiptClaim?.extractedAmount ?? null,
  extractedAccount: order.receiptClaim?.extractedAccount ?? null,
  verificationSource: order.receiptClaim?.source ?? null,
  hasReceiptImage: !!order.receiptClaim?.mediaId,
  claimedAt: order.receiptClaim?.claimedAt ?? null,
  createdAt: order.createdAt,
});

/**
 * The merchant's queue of receipts awaiting their confirmation.
 */
export async function listPendingConfirmations(req, res) {
  try {
    const { merchantId } = req.body || {};
    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchantId" });
    }

    const business = getBusinessByVelteUserId(merchantId);
    if (!business) {
      // Not connected here — return an empty queue rather than an error so the
      // dashboard renders cleanly for a merchant who never linked WhatsApp.
      return res.json({ success: true, pending: [] });
    }

    const orders = await getPendingConfirmations(business.id);
    return res.json({ success: true, pending: orders.map(toQueueItem) });
  } catch (error) {
    logger.error("[VendorConfirm] listPendingConfirmations error:", error);
    return res.status(500).json({ error: "Internal error" });
  }
}

/**
 * The vendor confirmed or rejected a held receipt.
 *   decision: "confirm" → mark paid, notify the customer, bridge to velte.
 *   decision: "reject"  → return the order to pending, tell the customer.
 */
export async function resolvePaymentClaim(req, res) {
  try {
    const { stafflyOrderId, decision } = req.body || {};
    if (!stafflyOrderId || !["confirm", "reject"].includes(decision)) {
      return res.status(400).json({
        error: "Require stafflyOrderId and decision ('confirm' | 'reject')",
      });
    }

    const order = await getOrderById(stafflyOrderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    // Idempotency / race guard: only an order still awaiting confirmation can be
    // resolved. If it was already settled (or another tab resolved it), say so.
    if (order.status !== "payment_claimed") {
      return res.status(409).json({
        error: "Order is not awaiting confirmation",
        status: order.status,
      });
    }

    const business = getBusinessById(order.businessId);

    if (decision === "confirm") {
      await markOrderPaid(stafflyOrderId, {
        receiptReference: order.receiptReference,
        verifiedBy: "vendor",
      });
      // Money's in — don't let the abandoned-checkout sweeper nudge them.
      await cancelFollowUpForOrder(stafflyOrderId);
      bridgeToVelte(business, order, "paid");
      await notifyCustomer(
        business,
        order.customerNumber,
        `✅ Payment confirmed for order ${order.id}${order.customerName ? `, ${order.customerName}` : ""}! Thank you — your order is now being processed. 🎉`,
      );
      logger.info(`[VendorConfirm] order ${order.id} confirmed by vendor`);
      return res.json({ success: true, status: "paid" });
    }

    // decision === "reject"
    await rejectOrderPaymentClaim(stafflyOrderId);
    await notifyCustomer(
      business,
      order.customerNumber,
      `Hi${order.customerName ? ` ${order.customerName}` : ""} — we couldn't confirm your payment for order ${order.id} yet. If you've paid, please double-check the amount and account and resend your receipt, or contact the seller directly.`,
    );
    logger.info(`[VendorConfirm] order ${order.id} rejected by vendor`);
    return res.json({ success: true, status: "pending" });
  } catch (error) {
    logger.error("[VendorConfirm] resolvePaymentClaim error:", error);
    return res.status(500).json({ error: "Internal error" });
  }
}

/**
 * Re-resolve the held receipt image so the dashboard can show it. The WhatsApp
 * media id is exchanged for the bytes using the business access token (valid
 * within Meta's ~14-day media retention). Returned as base64 so the response is
 * JSON (and signable the same way as the other calls). velte-backend should fetch
 * once and cache/re-host it rather than hot-linking per render.
 */
export async function getReceiptImage(req, res) {
  try {
    const { stafflyOrderId } = req.body || {};
    if (!stafflyOrderId) {
      return res.status(400).json({ error: "Missing stafflyOrderId" });
    }

    const order = await getOrderById(stafflyOrderId);
    const mediaId = order?.receiptClaim?.mediaId;
    if (!order || !mediaId) {
      return res.status(404).json({ error: "No receipt image for this order" });
    }

    const business = getBusinessById(order.businessId);
    if (!business?.access_token) {
      return res.status(404).json({ error: "Business not connected" });
    }

    try {
      const media = await whatsapp.downloadMedia(mediaId, business.access_token);
      return res.json({
        success: true,
        mimeType: media.mimeType,
        base64: media.buffer.toString("base64"),
      });
    } catch (e) {
      // Media expired (past Meta's retention) or download failed.
      logger.warn(
        `[VendorConfirm] receipt image fetch failed for ${stafflyOrderId}: ${e.message}`,
      );
      return res
        .status(502)
        .json({ error: "Receipt image is no longer available" });
    }
  } catch (error) {
    logger.error("[VendorConfirm] getReceiptImage error:", error);
    return res.status(500).json({ error: "Internal error" });
  }
}

// Surface the now-paid order in the merchant's velte dashboard (fire-and-forget —
// the StafflyOrder is the source of truth; a bridge hiccup must not fail the call).
function bridgeToVelte(business, order, paymentStatus) {
  const merchantId = business?.velteUserId || null;
  if (!merchantId) {
    logger.error(
      `[VendorConfirm] business ${order.businessId} has no velteUserId — order ${order.id} NOT bridged (won't appear in the merchant dashboard).`,
    );
    return;
  }
  velteService.notifyVelteOrder({
    stafflyOrderId: order.id,
    merchantId,
    paymentStatus,
    product: order.product,
    productImage: order.productImage,
    amount: order.amount,
    quantity: order.quantity,
    items: order.items,
    customerName: order.customerName,
    customerPhone: order.customerNumber,
    customerEmail: order.customerEmail,
    deliveryAddress: order.location,
  });
}

async function notifyCustomer(business, to, msg) {
  if (!business?.phone_number_id || !to) {
    logger.warn(
      "[VendorConfirm] cannot notify customer — missing business creds or number",
    );
    return;
  }
  try {
    await whatsapp.sendTextMessage(
      business.phone_number_id,
      business.access_token,
      to,
      msg,
    );
  } catch (err) {
    logger.error(`[VendorConfirm] failed to notify ${to}: ${err.message}`);
  }
}
