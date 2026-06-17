import { getOrderById, updateOrderStatus } from '../models/Order.js';
import { getBusinessByPhoneNumberId } from '../models/Business.js';
import { cancelFollowUpForOrder } from '../models/ConversationState.js';
import * as whatsapp from '../services/whatsapp.service.js';
import { logger } from '../utils/logger.js';

const naira = (amount) =>
  typeof amount === 'number' ? `₦${amount.toLocaleString()}` : null;

/**
 * Receiver for events dispatched by velte-backend's `dispatchToStaffly()`.
 *
 * Payload shape (see velte-backend/src/utils/stafflyWebhook.js):
 *   { event, phoneNumberId, data }
 *
 * `phoneNumberId` is the merchant's AISetup.selectedNumberId, which maps to a
 * connected Business here — giving us the WhatsApp credentials to notify the
 * customer. The request is signature-verified upstream by verifyVelteSignature.
 *
 * Events handled:
 *   - order.paid          → flip the tracked StafflyOrder to paid, clear the
 *                           abandoned-checkout follow-up, send the customer a
 *                           confirmation. (This closes the WhatsApp payment loop.)
 *   - order.created       → notify the customer their order was placed.
 *   - order.status_changed→ notify the customer of the new fulfilment status.
 */
export async function handleVelteWebhook(req, res) {
  try {
    const { event, phoneNumberId, data } = req.body || {};

    if (!event || !phoneNumberId || !data) {
      return res.status(400).json({ error: 'Missing event, phoneNumberId, or data' });
    }

    const business = getBusinessByPhoneNumberId(phoneNumberId);
    if (!business) {
      // Ack with 200 so velte doesn't retry an event we can never route (the
      // merchant isn't connected here). Log it so the gap is visible.
      logger.warn(
        `[Velte] No connected business for phoneNumberId ${phoneNumberId} — ignoring "${event}" event`,
      );
      return res.json({ success: true, ignored: true });
    }

    switch (event) {
      case 'order.paid':
        await handleOrderPaid(business, data);
        break;
      case 'order.created':
        await handleOrderCreated(business, data);
        break;
      case 'order.status_changed':
        await handleOrderStatusChanged(business, data);
        break;
      default:
        logger.info(`[Velte] Unhandled event "${event}" — acknowledged`);
    }

    logger.info(`[Velte] Handled "${event}" for business ${business.id}`);
    return res.json({ success: true });
  } catch (error) {
    logger.error('[Velte] Webhook error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * A customer completed payment on their velte pay link. velte sends back the
 * `stafflyOrderId` we attached as Paystack metadata at checkout, so we can find
 * the checkout intent we created and close it out.
 */
async function handleOrderPaid(business, data) {
  const orderId = data.stafflyOrderId || data.orderId || data.reference || null;
  const order = orderId ? await getOrderById(orderId) : null;

  if (order) {
    await updateOrderStatus(orderId, 'paid');
    // Payment landed — make sure the abandoned-checkout sweeper never nudges
    // this customer about an order they already settled.
    await cancelFollowUpForOrder(orderId);
  } else if (orderId) {
    logger.warn(`[Velte] order.paid for unknown StafflyOrder ${orderId} — notifying via payload only`);
  }

  // Prefer the tracked order's details; fall back to whatever velte sent.
  const to = order?.customerNumber || data.customerPhone;
  const productName = order?.product || data.product || 'your order';
  if (!to) {
    logger.warn('[Velte] order.paid has no customer number to notify');
    return;
  }

  const amountText = naira(order?.amount ?? data.amount);
  const trackingUrl = typeof data.trackingUrl === 'string' ? data.trackingUrl : null;

  let msg =
    `✅ *Payment confirmed!*\n\n` +
    `Your order for *${productName}*${amountText ? ` (${amountText})` : ''} has been received ` +
    `and is now being processed.`;
  if (trackingUrl) {
    msg += `\n\nView or track your order here:\n${trackingUrl}`;
  }
  msg += `\n\nThank you for shopping with ${business.name}!`;

  await sendCustomerMessage(business, to, msg);
}

/**
 * The merchant (or an upstream order flow) created an order. Let the customer
 * know it's in. Driven off velte's `orders` collection, so the items array is
 * the source of truth for what was ordered.
 */
async function handleOrderCreated(business, data) {
  const to = data.customerPhone;
  if (!to) {
    logger.warn('[Velte] order.created has no customerPhone to notify');
    return;
  }

  const itemsText = Array.isArray(data.items) && data.items.length
    ? data.items.map((i) => `• ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join('\n')
    : null;
  const amountText = naira(data.amount);

  const msg =
    `🧾 Your order with ${business.name} has been placed!` +
    (itemsText ? `\n\n${itemsText}` : '') +
    (amountText ? `\n\n*Total: ${amountText}*` : '') +
    `\n\nWe'll keep you posted on its progress.`;

  await sendCustomerMessage(business, to, msg);
}

/**
 * The merchant moved an order to a new fulfilment status. Surface it to the
 * customer in plain language.
 */
async function handleOrderStatusChanged(business, data) {
  const to = data.customerPhone;
  if (!to) {
    logger.warn('[Velte] order.status_changed has no customerPhone to notify');
    return;
  }

  const phrases = {
    Preparing: '👨‍🍳 is now being prepared',
    Ready: '✅ is ready',
    OnTheWay: '🛵 is on the way',
    Shipped: '📦 has been shipped',
    Delivered: '🎉 has been delivered',
    Cancelled: '❌ has been cancelled',
  };
  const phrase = phrases[data.newStatus] || `is now: ${data.newStatus}`;

  let msg = `Update from ${business.name}: your order ${phrase}.`;
  if (data.newStatus === 'Cancelled' && data.cancellationReason) {
    msg += `\n\nReason: ${data.cancellationReason}`;
  }

  await sendCustomerMessage(business, to, msg);
}

async function sendCustomerMessage(business, to, msg) {
  try {
    await whatsapp.sendTextMessage(
      business.phone_number_id,
      business.access_token,
      to,
      msg,
    );
  } catch (err) {
    // A WhatsApp send failure must not 500 the webhook (velte would retry and
    // re-send). Log and move on; the event is still considered handled.
    logger.error(`[Velte] Failed to notify ${to}: ${err.message}`);
  }
}
