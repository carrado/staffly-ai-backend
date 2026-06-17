import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Verify a webhook dispatched by velte-backend's `dispatchToStaffly()`.
 *
 * velte signs the raw JSON body with HMAC-SHA256 keyed by the shared
 * VELTE_WEBHOOK_SECRET and sends it as:
 *   x-velte-signature: sha256=<hex digest>
 *
 * Mirrors `signature.verify.js` (the Meta webhook guard): in development the
 * check is skipped when the header is absent so the endpoint is easy to curl;
 * in production a missing or mismatched signature is rejected.
 */
export function verifyVelteSignature(req, res, next) {
  const signature = req.headers['x-velte-signature'];

  if (!signature) {
    if (env.nodeEnv === 'production') {
      logger.warn('[VelteSignature] Rejected: no x-velte-signature header');
      return res.status(401).send('Missing signature');
    }
    return next();
  }

  if (!env.velteWebhookSecret) {
    logger.error('[VelteSignature] VELTE_WEBHOOK_SECRET is not configured — cannot verify velte webhooks');
    return res.status(500).send('Webhook secret not configured');
  }

  if (!req.rawBody) {
    logger.error('[VelteSignature] Raw body not found. Ensure express.json({ verify: ... }) is configured.');
    return res.status(500).send('Internal Server Error');
  }

  const hmac = crypto.createHmac('sha256', env.velteWebhookSecret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  if (
    digestBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(digestBuffer, signatureBuffer)
  ) {
    logger.warn(
      '[VelteSignature] Rejected: signature mismatch — check that VELTE_WEBHOOK_SECRET matches velte-backend',
    );
    return res.status(401).send('Invalid signature');
  }

  next();
}
