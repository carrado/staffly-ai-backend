import { Router } from 'express';
import { verifyVelteSignature } from '../middleware/velte.signature.verify.js';
import { handleVelteWebhook } from '../controllers/velte.controller.js';

const router = Router();

// Signed events dispatched by velte-backend (order.paid / order.created /
// order.status_changed). Mounted under /api → POST /api/velte/webhook, which
// is the URL velte-backend's STAFFLY_WEBHOOK_URL should point at.
router.post('/velte/webhook', verifyVelteSignature, handleVelteWebhook);

export default router;
