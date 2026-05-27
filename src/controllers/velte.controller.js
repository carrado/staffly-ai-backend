import { getBusinessByPhoneNumberId } from '../models/Business.js';
import * as whatsapp from '../services/whatsapp.service.js';
import { logger } from '../utils/logger.js';

// ─── Message builders ─────────────────────────────────────────────────────────

function formatItems(items = []) {
  return items
    .map((item, i) => `${i + 1}. ${item.name} x${item.quantity} — ₦${item.lineTotal?.toLocaleString()}`)
    .join('\n');
}

function formatAmount(amount) {
  return `₦${Number(amount || 0).toLocaleString()}`;
}

const STATUS_MESSAGES = {
  Preparing:  (d, b) => `👨‍🍳 Your order #${d.orderId} is now being prepared by ${b.name}! We'll notify you when it's ready.`,
  Ready:      (d, b) => `🎉 Your order #${d.orderId} is ready! It'll be on its way to you shortly.`,
  Shipped:    (d, b) => `🚚 Your order #${d.orderId} has been shipped and is on its way to you.`,
  OnTheWay:   (d, b) => `🛵 Your delivery for order #${d.orderId} is almost there! Please be available to receive it.`,
  Delivered:  (d, b) => `✅ Order #${d.orderId} has been delivered! Thank you for shopping with ${b.name}. Enjoy! 🎊`,
  Cancelled:  (d, b) => `❌ Order #${d.orderId} has been cancelled.${d.cancellationReason ? `\n\nReason: ${d.cancellationReason}` : ''}\n\nIf this was a mistake, please message us and we'll sort it out.`,
};

// ─── Event handlers ───────────────────────────────────────────────────────────

const EVENT_HANDLERS = {
  'order.created'(business, data) {
    const itemsList = formatItems(data.items);
    return (
      `Hello ${data.customerName}! 👋\n\n` +
      `Your order has been received:\n\n` +
      `🧾 *Order #${data.orderId}*\n${itemsList}\n\n` +
      `💰 Total: ${formatAmount(data.amount)}\n\n` +
      `We'll notify you as it progresses. Thank you for shopping with ${business.name}!`
    );
  },

  'order.paid'(business, data) {
    return (
      `✅ *Payment Confirmed!*\n\n` +
      `Hi ${data.customerName}, we've received your payment of ${formatAmount(data.amount)} ` +
      `for order #${data.orderId}.\n\n` +
      `Your order is now being processed. We'll keep you updated every step of the way! 🙏`
    );
  },

  'order.status_changed'(business, data) {
    const handler = STATUS_MESSAGES[data.newStatus];
    if (!handler) return null;
    return handler(data, business);
  },

  'product.restocked'(business, data) {
    return (
      `Good news from ${business.name}! 🎉\n\n` +
      `*${data.productName}* is back in stock!\n\n` +
      `Reply to this message to place your order before it sells out again.`
    );
  },

  'invoice.ready'(business, data) {
    return (
      `📄 *Your Invoice is Ready!*\n\n` +
      `Order #${data.orderId}\n` +
      `Amount: ${formatAmount(data.amount)}\n\n` +
      `View and download your invoice here:\n${data.invoiceUrl}\n\n` +
      `Thank you for your purchase from ${business.name}!`
    );
  },

  'receipt.ready'(business, data) {
    return (
      `🧾 *Payment Receipt*\n\n` +
      `Order #${data.orderId} — ${formatAmount(data.amount)}\n` +
      `Paid on: ${data.paidAt ? new Date(data.paidAt).toLocaleDateString('en-NG', { dateStyle: 'medium' }) : 'today'}\n\n` +
      `Download your receipt here:\n${data.receiptUrl}\n\n` +
      `Thank you for shopping with ${business.name}!`
    );
  },

  'escalation.requested'(business, data) {
    const { merchant } = data;
    return (
      `We understand your concern and want to make sure you're well taken care of. 🙏\n\n` +
      `For immediate assistance, you can reach the team directly:\n\n` +
      `👤 ${merchant.name}\n` +
      `📞 ${merchant.phone}\n` +
      (merchant.email ? `📧 ${merchant.email}\n` : '') +
      `\nThey'll be happy to resolve any issue for you.`
    );
  },
};

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleVelteEvent(req, res) {
  res.sendStatus(200);

  try {
    const { event, phoneNumberId, data } = req.body;

    if (!event || !phoneNumberId || !data) {
      logger.warn('[Velte] Invalid payload — missing event, phoneNumberId, or data');
      return;
    }

    const business = getBusinessByPhoneNumberId(phoneNumberId);
    if (!business) {
      logger.warn(`[Velte] No business found for phoneNumberId: ${phoneNumberId}`);
      return;
    }

    const handler = EVENT_HANDLERS[event];
    if (!handler) {
      logger.warn(`[Velte] Unknown event type: "${event}"`);
      return;
    }

    const messageText = handler(business, data);
    if (!messageText) {
      logger.warn(`[Velte] No message template for event "${event}" with status "${data.newStatus}"`);
      return;
    }

    const customerPhone = data.customerPhone;
    if (!customerPhone) {
      logger.warn(`[Velte] No customerPhone in event: ${event}`);
      return;
    }

    await whatsapp.sendTextMessage(
      business.phone_number_id,
      business.access_token,
      customerPhone,
      messageText,
    );

    logger.info(`[Velte] [${event}] → sent to ${customerPhone} via ${business.name}`);
  } catch (error) {
    logger.error('[Velte] Error handling event:', error);
  }
}
