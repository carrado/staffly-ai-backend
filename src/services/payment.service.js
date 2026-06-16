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
export async function generatePaymentLink(businessId, customerNumber, productName, amount, buyer = {}) {
  const order = await createOrder({
    businessId,
    customerNumber,
    product: productName,
    amount,
    customerName: buyer.customerName || null,
    customerEmail: buyer.customerEmail || null,
    location: buyer.location || null,
  });

  const velteUserId = getBusinessById(businessId)?.velteUserId || null;

  let paymentLink = null;
  if (velteUserId) {
    try {
      // The merchant's own velte payment link: active, not deleted, and not past
      // its expiry (a null expiresAt never expires). Newest active link wins.
      const link = await PaymentLink.findOne({
        userId: velteUserId,
        isActive: true,
        deletedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      })
        .sort({ createdAt: -1 })
        .lean();
      if (link?.url) paymentLink = link.url;

      // Development aid: dump every PaymentLink this merchant has (with the
      // fields that decide selection) plus the one we picked, so you can see why
      // a given link was or wasn't chosen.
      if (env.nodeEnv === 'development') {
        const all = await PaymentLink.find({ userId: velteUserId })
          .sort({ createdAt: -1 })
          .select('linkId url isActive deletedAt expiresAt amount')
          .lean();
        logger.info(
          `[Payment][dev] velteUserId ${velteUserId} has ${all.length} PaymentLink(s): ` +
            JSON.stringify(
              all.map((l) => ({
                linkId: l.linkId,
                url: l.url,
                isActive: l.isActive,
                deleted: !!l.deletedAt,
                expiresAt: l.expiresAt,
                amount: l.amount,
              })),
            ),
        );
        logger.info(
          `[Payment][dev] order ${order.id} → selected link: ${link?.url || '(none — placeholder will be used)'}`,
        );
      }
    } catch (err) {
      // A malformed velteUserId (cast error) or DB hiccup must not sink the
      // checkout — fall through to the placeholder below.
      logger.error(
        `[Payment] PaymentLink lookup failed for business ${businessId} (velteUserId: ${velteUserId}): ${err.message}`,
      );
    }
  }

  if (!paymentLink) {
    // Fall back to the internal placeholder so the flow still completes, and
    // flag it loudly. The reason matters, so spell it out: no velteUserId on the
    // business at all (likely connected via the OAuth callback, which doesn't set
    // it) vs. a velteUserId that simply has no usable PaymentLink.
    paymentLink = `${env.baseUrl}/pay/${order.id}`;
    if (!velteUserId) {
      logger.warn(
        `[Payment] Business ${businessId} has NO velteUserId — can't map to a velte PaymentLink; using placeholder. (Was it connected via the OAuth callback instead of loaded from AISetup?)`,
      );
    } else {
      let diag = '';
      try {
        const total = await PaymentLink.countDocuments({ userId: velteUserId });
        const active = await PaymentLink.countDocuments({
          userId: velteUserId,
          isActive: true,
          deletedAt: null,
        });
        diag = ` — paymentlinks for this user: ${total} total, ${active} active+not-deleted (need at least one active, not-deleted, not-expired, with a url)`;
      } catch {
        // diagnostics are best-effort
      }
      logger.warn(
        `[Payment] No usable velte PaymentLink for business ${businessId} (velteUserId: ${velteUserId})${diag} — using placeholder link`,
      );
    }
  }

  return { paymentLink, orderId: order.id };
}
