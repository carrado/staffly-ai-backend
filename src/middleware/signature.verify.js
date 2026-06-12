import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export function verifySignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];

  if (!signature) {
    if (env.nodeEnv === 'production') {
      logger.warn('[Signature] Rejected: no X-Hub-Signature-256 header');
      return res.status(401).send('Missing signature');
    }
    return next();
  }

  // Ensure you have rawBody available from your body-parser config
  if (!req.rawBody) {
    console.error('Raw body not found. Ensure express.json({ verify: ... }) is configured.');
    return res.status(500).send('Internal Server Error');
  }

  const hmac = crypto.createHmac('sha256', env.metaAppSecret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  if (digestBuffer.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(digestBuffer, signatureBuffer)) {
    logger.warn('[Signature] Rejected: signature mismatch — check that META_APP_SECRET matches the Meta app sending this webhook');
    return res.status(401).send('Invalid signature');
  }

  next();
}