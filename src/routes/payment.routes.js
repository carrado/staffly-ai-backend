import { Router } from 'express';
import { handlePaymentWebhook } from '../controllers/payment.controller.js';

const router = Router();

// Mock payment gateway webhook
router.post('/payment-webhook', handlePaymentWebhook);

export default router;