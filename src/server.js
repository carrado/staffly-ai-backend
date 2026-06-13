import mongoose from 'mongoose';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { connectDatabase } from './config/database.js';
import { loadBusinessesFromDB } from './services/business.service.js';
import { startKeepAlive } from './initializers/keepAlive.js';
import { startPaymentFollowUps } from './initializers/paymentFollowUp.js';
import { flushAllPending } from './models/ConversationState.js';

const DB_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // re-sync every hour
const SHUTDOWN_TIMEOUT_MS = 10 * 1000; // hard cap so a hung close can't wedge the box

function setupGracefulShutdown(server) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Shutdown] ${signal} received — draining and flushing sessions...`);

    // Never let a stuck connection or DB call hold the process open forever.
    const hardExit = setTimeout(() => {
      logger.error('[Shutdown] Timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();

    // Stop accepting new requests, let in-flight ones finish, THEN flush the
    // debounced session writes (Mongo is still open at this point) and close.
    server.close(async () => {
      try {
        await flushAllPending();
      } catch (err) {
        logger.error('[Shutdown] Session flush failed:', err);
      }
      try {
        await mongoose.connection.close();
      } catch (err) {
        logger.error('[Shutdown] Mongo close failed:', err);
      }
      clearTimeout(hardExit);
      logger.info('[Shutdown] Clean exit');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function start() {
  await connectDatabase();

  // Load real businesses from MongoDB (all completed AI setups)
  await loadBusinessesFromDB();

  // Periodic refresh — picks up newly connected businesses and refreshed tokens
  setInterval(
    () => loadBusinessesFromDB().catch((err) => logger.error('[Business] Refresh failed:', err)),
    DB_REFRESH_INTERVAL_MS,
  );

  const server = app.listen(env.port, () => {
    logger.info(`🚀 Staffly AI running on port ${env.port} [${env.nodeEnv}]`);
    logger.info(`   Webhook URL : ${env.baseUrl}/webhook`);
    logger.info(`   OAuth URL   : ${env.baseUrl}/auth/meta/callback`);

    // Keep free-tier hosting from idling the instance to sleep
    startKeepAlive();

    // Nudge customers who got a payment link but never paid
    startPaymentFollowUps();
  });

  // Flush debounced session writes before the process dies (deploys, SIGTERM).
  setupGracefulShutdown(server);
}

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
