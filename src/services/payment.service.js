import { createOrder } from "../models/Order.js";
import { getBusinessById } from "../models/Business.js";
import { PaymentLink } from "../models/mongoose/PaymentLink.js";
import { logger } from "../utils/logger.js";

/**
 * The merchant's saved bank account (newest active, not-deleted record in the
 * shared `paymentlinks` collection, keyed by velteUserId). Returns
 * `{ accountName, accountNumber, bankName }` or null when none is saved. Used both
 * to tell a customer where to pay and to verify their uploaded receipt against the
 * right destination account.
 */
export async function getVendorBankDetails(businessId) {
  const velteUserId = getBusinessById(businessId)?.velteUserId || null;
  if (!velteUserId) {
    logger.warn(
      `[Payment] Business ${businessId} has no velteUserId — can't resolve a bank account.`,
    );
    return null;
  }
  try {
    const account = await PaymentLink.findOne({
      userId: velteUserId,
      isActive: true,
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .lean();
    if (account?.accountNumber && account?.accountName) {
      return {
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        bankName: account.bankName || null,
      };
    }
  } catch (err) {
    // A malformed velteUserId (cast error) or DB hiccup must not crash the flow.
    logger.error(
      `[Payment] Bank account lookup failed for business ${businessId} (velteUserId: ${velteUserId}): ${err.message}`,
    );
  }
  return null;
}

/**
 * Place a checkout order and return the merchant's bank details for the customer
 * to pay by DIRECT bank transfer.
 *
 * We create a StafflyOrder (so the order, the abandoned-checkout follow-up, and
 * the later receipt verification have something to track) and look up the
 * merchant's saved bank account. No payment link / Paystack is involved: the
 * customer transfers to the account and later uploads a receipt, which is verified
 * to mark the order paid.
 *
 * Returns `{ bankDetails, orderId }`. `bankDetails` is null when the merchant
 * hasn't saved a bank account yet — the caller must handle that (the customer
 * can't be told where to pay).
 */
export async function placeOrder(
  businessId,
  customerNumber,
  productName,
  amount,
  buyer = {},
) {
  const order = await createOrder({
    businessId,
    customerNumber,
    product: productName,
    // Underlying product identity + photo, so the real velte order can show the
    // product image. `productName` stays the human label with variants/modifiers.
    productId: buyer.productId || null,
    productImage: buyer.productImage || null,
    amount,
    quantity: buyer.quantity || 1,
    // Per-variant line breakdown (one entry for a plain order, several for a
    // multi-variant one), so the fulfilment order shows each line.
    items: Array.isArray(buyer.items) ? buyer.items : [],
    customerName: buyer.customerName || null,
    customerEmail: buyer.customerEmail || null,
    location: buyer.location || null,
  });

  const bankDetails = await getVendorBankDetails(businessId);
  if (!bankDetails) {
    logger.warn(
      `[Payment] No saved bank account for business ${businessId} — the customer ` +
        `can't be given transfer details. Ask the merchant to add their bank account in Velte.`,
    );
  }

  return { bankDetails, orderId: order.id };
}
