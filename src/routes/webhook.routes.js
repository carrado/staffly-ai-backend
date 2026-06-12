import { Router } from 'express';
import { verifySignature } from '../middleware/signature.verify.js';
import { handleIncomingMessage } from '../controllers/webhook.controller.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Meta webhook verification challenge (GET)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.metaVerifyToken) {
    logger.info('[Webhook] Verification challenge accepted');
    return res.status(200).send(challenge);
  }
  logger.warn(`[Webhook] Verification challenge REJECTED (mode=${mode}, token matched=${token === env.metaVerifyToken})`);
  return res.sendStatus(403);
});

// Incoming WhatsApp messages (POST) — shared across ALL connected businesses.
// Log before signature verification so even rejected deliveries leave a trace.
router.post(
  '/',
  (req, res, next) => {
    logger.info(`[Webhook] POST received (signature ${req.headers['x-hub-signature-256'] ? 'present' : 'MISSING'})`);
    next();
  },
  verifySignature,
  handleIncomingMessage,
);

export default router;
