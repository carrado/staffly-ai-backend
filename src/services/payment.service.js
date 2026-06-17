import { createOrder } from '../models/Order.js';
import { getBusinessById } from '../models/Business.js';
import { PaymentLink } from '../models/mongoose/PaymentLink.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Append a query param to a URL, picking `?` vs `&` correctly and leaving any
 * existing query/fragment intact. Kept dependency-free (no URL parsing) so it
 * works for the bare velte link and the internal placeholder alike.
 */
function appendQueryParam(url, key, value) {
  const [base, hash = ''] = String(url).split('#');
  const sep = base.includes('?') ? '&' : '?';
  const qs = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  return `${base}${sep}${qs}${hash ? `#${hash}` : ''}`;
}

/**
 * Resolve the payment link a customer should be sent for a checkout.
 *
 * The real, displayable link is the merchant's own velte PaymentLink — the
 * `url` field of their record in the shared `paymentlinks` collection, keyed by
 * the business's velteUserId. We prefer an OPEN-AMOUNT link so the exact (and
 * possibly negotiated) checkout `amount` is what gets charged; a fixed-amount
 * link is only a last resort and is flagged. We still create a Staffly order so
 * the payment webhook and the abandoned-checkout follow-up have something to
 * track, and we return its id as the order reference to show the customer.
 *
 * The merchant's velte PaymentLink is STATIC (one link, reused for every
 * customer), so on its own it carries no order context. We attach our order id
 * as a `ref` query param — the velte pay page reads it and the velte initialize
 * endpoint looks up this checkout (amount, items, buyer) to build the Paystack
 * `metadata.stafflyOrderId`, which flows through to the `order.paid` webhook and
 * back to us. `ref` is an opaque pointer only; amount/PII stay server-side (in
 * the StafflyOrder), never in the URL where a customer could tamper with them.
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
      // its expiry (a null expiresAt never expires).
      const activeFilter = {
        userId: velteUserId,
        isActive: true,
        deletedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      };

      // Prefer an OPEN-AMOUNT link (amount null/missing). The amount we charge is
      // this checkout's exact total — which carries any NEGOTIATED price — and
      // velte resolves it from the StafflyOrder via `ref`. Only an open-amount
      // link can take that per-order amount; a FIXED-amount link would charge its
      // own preset price and silently override what the customer agreed. So we
      // only fall back to a fixed-amount link when the merchant has no open one,
      // and flag it loudly. Newest qualifying link wins.
      const openLink = await PaymentLink.findOne({ ...activeFilter, amount: null })
        .sort({ createdAt: -1 })
        .lean();
      const link =
        openLink ||
        (await PaymentLink.findOne(activeFilter).sort({ createdAt: -1 }).lean());
      if (link?.url) {
        paymentLink = link.url;
        if (link.amount != null) {
          logger.warn(
            `[Payment] Business ${businessId}: only a FIXED-amount velte PaymentLink ` +
              `(₦${Number(link.amount).toLocaleString()}) is available — the agreed checkout ` +
              `amount ₦${Number(amount).toLocaleString()} may NOT be charged at pay time. ` +
              `Ask the merchant to add an open-amount payment link.`,
          );
        }
      }

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

  // Attach our order id so the velte pay page / initialize endpoint can resolve
  // exactly which checkout this payment is for. The placeholder already encodes
  // order.id in its path, but tagging `ref` uniformly keeps the pay-page logic
  // (read linkId from path, ref from query) the same for both link shapes.
  const paymentLinkWithRef = appendQueryParam(paymentLink, 'ref', order.id);

  return { paymentLink: paymentLinkWithRef, orderId: order.id };
}
