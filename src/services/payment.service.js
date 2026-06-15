import { createOrder } from '../models/Order.js';
import { getBusinessById } from '../models/Business.js';
import { PaymentLink } from '../models/mongoose/PaymentLink.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Resolve the payment link a customer should be sent for a checkout.
 *
 * The real, displayable link is the merchant's own velte PaymentLink — the
 * `url` field of their record in the shared `paymentlinks` collection, keyed by
 * the business's velteUserId. We still create a Staffly order so the payment
 * webhook and the abandoned-checkout follow-up have something to track, and we
 * return its id as the order reference to show the customer alongside the link.
 */
export async function generatePaymentLink(businessId, customerNumber, productName, amount) {
  const order = await createOrder({ businessId, customerNumber, product: productName, amount });

  const velteUserId = getBusinessById(businessId)?.velteUserId || null;

  let paymentLink = null;
  if (velteUserId) {
    const link = await PaymentLink.findOne({
      userId: velteUserId,
      isActive: true,
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .lean();
    if (link?.url) paymentLink = link.url;
  }

  if (!paymentLink) {
    // Merchant hasn't set up a payment link yet — fall back to the internal
    // placeholder so the flow still completes, and flag it loudly.
    paymentLink = `${env.baseUrl}/pay/${order.id}`;
    logger.warn(
      `[Payment] No active velte PaymentLink for business ${businessId} (velteUserId: ${velteUserId ?? 'none'}) — using placeholder link`,
    );
  }

  return { paymentLink, orderId: order.id };
}
