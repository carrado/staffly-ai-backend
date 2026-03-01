import crypto from 'crypto';
import { env } from '../config/env.js';

export function verifySignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return next();

  const expectedSignature =
    'sha256=' +
    crypto
      .createHmac('sha256', env.metaAppSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(401).send('Invalid signature');
  }
  next();
}