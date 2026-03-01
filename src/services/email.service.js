import { logger } from '../utils/logger.js';

export async function sendInvoiceEmail(customerEmail, orderDetails) {
  logger.info(`Sending invoice to ${customerEmail}:`, orderDetails);
  // Integrate with nodemailer or SendGrid here
}

export async function sendReceiptEmail(customerEmail, orderDetails) {
  logger.info(`Sending receipt to ${customerEmail}:`, orderDetails);
}