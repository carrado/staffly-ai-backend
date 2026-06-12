/**
 * Keep-Alive Self-Ping
 *
 * Free hosting tiers (Render, Railway, fly.io, ...) put the service to sleep
 * after ~15 minutes without inbound traffic. A sleeping instance cold-starts
 * on the next WhatsApp message — slow enough that Meta may retry or the
 * customer notices a dead pause. Pinging our own /health endpoint keeps the
 * instance warm.
 */

import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const PING_INTERVAL_MS = 10 * 60 * 1000; // comfortably under the ~15-min idle cutoff
const PING_TIMEOUT_MS = 30 * 1000;       // generous — a waking instance answers slowly

export function startKeepAlive() {
  // Pinging localhost defeats the purpose, and dev servers are allowed to sleep.
  if (env.nodeEnv !== 'production' || env.baseUrl.includes('localhost')) {
    logger.info('[KeepAlive] Skipped (requires NODE_ENV=production and a public BASE_URL)');
    return;
  }

  const url = `${env.baseUrl.replace(/\/+$/, '')}/health`;

  const timer = setInterval(async () => {
    try {
      await axios.get(url, { timeout: PING_TIMEOUT_MS });
    } catch (err) {
      // Failures only — a success line every 10 minutes is just log noise.
      logger.warn(`[KeepAlive] Ping failed: ${err.message}`);
    }
  }, PING_INTERVAL_MS);

  // The pinger must never be the thing keeping a shutting-down process alive.
  timer.unref();

  logger.info(`[KeepAlive] Self-ping every ${PING_INTERVAL_MS / 60000} min → ${url}`);
}
