import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { connectDatabase } from './config/database.js';
import { loadBusinessesFromDB } from './services/business.service.js';
import { startKeepAlive } from './initializers/keepAlive.js';

const DB_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // re-sync every hour

async function start() {
  await connectDatabase();

  // Load real businesses from MongoDB (all completed AI setups)
  await loadBusinessesFromDB();

  // Periodic refresh — picks up newly connected businesses and refreshed tokens
  setInterval(
    () => loadBusinessesFromDB().catch((err) => logger.error('[Business] Refresh failed:', err)),
    DB_REFRESH_INTERVAL_MS,
  );

  app.listen(env.port, () => {
    logger.info(`🚀 Staffly AI running on port ${env.port} [${env.nodeEnv}]`);
    logger.info(`   Webhook URL : ${env.baseUrl}/webhook`);
    logger.info(`   OAuth URL   : ${env.baseUrl}/auth/meta/callback`);

    // Keep free-tier hosting from idling the instance to sleep
    startKeepAlive();
  });
}

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
