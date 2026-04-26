import { logger } from '../utils/logger.js';

/**
 * Send an invoice email after a payment link is generated.
 * Replace with a real email provider (SendGrid, Nodemailer, etc.)
 */
export async function sendInvoiceEmail(to, { product, orderId }) {
  // TODO: integrate real email provider
  logger.info(`[EMAIL] Invoice for order ${orderId} → ${to} | Product: ${product.name} | Price: ${product.price}`);
}
