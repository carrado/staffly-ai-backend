import { Router } from 'express';
import { verifySignature } from '../middleware/signature.verify.js';
import { handleIncomingMessage } from '../controllers/webhook.controller.js';
import { env } from '../config/env.js';

const router = Router();

// Meta webhook verification challenge (GET)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.metaVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming WhatsApp messages (POST) — shared across ALL connected businesses
router.post('/', verifySignature, handleIncomingMessage);

export default router;
