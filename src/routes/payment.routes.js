import { Router } from 'express';
import { handlePaymentWebhook } from '../controllers/payment.controller.js';

const router = Router();

// Payment gateway webhook (Paystack / Flutterwave / Stripe callback)
router.post('/payment/webhook', handlePaymentWebhook);

export default router;
