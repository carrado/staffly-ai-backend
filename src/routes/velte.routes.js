import { Router } from 'express';
import { verifyVelteSignature } from '../middleware/velte.signature.verify.js';
import { handleVelteWebhook } from '../controllers/velte.controller.js';
import {
  listPendingConfirmations,
  resolvePaymentClaim,
  getReceiptImage,
} from '../controllers/vendorConfirmation.controller.js';

const router = Router();

// Signed events dispatched by velte-backend (order.paid / order.created /
// order.status_changed). Mounted under /api → POST /api/velte/webhook, which
// is the URL velte-backend's STAFFLY_WEBHOOK_URL should point at.
router.post('/velte/webhook', verifyVelteSignature, handleVelteWebhook);

// Vendor payment confirmation — the velte dashboard reads the queue of receipts
// held for human review and posts back the vendor's confirm/reject decision.
// Same shared-secret signature as the webhook (server-to-server from velte).
router.post('/velte/pending-confirmations', verifyVelteSignature, listPendingConfirmations);
router.post('/velte/confirm-payment', verifyVelteSignature, resolvePaymentClaim);
router.post('/velte/receipt-image', verifyVelteSignature, getReceiptImage);

export default router;
