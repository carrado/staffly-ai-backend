import crypto from 'crypto';
import { env } from '../config/env.js';

export function verifyVelteSignature(req, res, next) {
  const signature = req.headers['x-velte-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  if (!req.rawBody) {
    return res.status(500).json({ error: 'Raw body not available' });
  }

  const hmac = crypto.createHmac('sha256', env.velteWebhookSecret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  if (
    digestBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(digestBuffer, signatureBuffer)
  ) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  next();
}
