import { logger } from '../utils/logger.js';

/**
 * Send an invoice email after a payment link is generated.
 * Replace with a real email provider (SendGrid, Nodemailer, etc.)
 */
export async function sendInvoiceEmail(to, { product, orderId, amount, customerName, location }) {
  // `amount` reflects a negotiated/agreed price when present; otherwise fall
  // back to the product's list price.
  const price = amount ?? product.price;
  // TODO: integrate real email provider
  const buyer = [customerName && `Name: ${customerName}`, location && `Deliver to: ${location}`]
    .filter(Boolean)
    .join(' | ');
  logger.info(
    `[EMAIL] Invoice for order ${orderId} → ${to} | Product: ${product.name} | Price: ${price}${buyer ? ` | ${buyer}` : ''}`,
  );
}
