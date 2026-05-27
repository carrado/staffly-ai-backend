import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { connectDatabase } from './config/database.js';
import { loadBusinessesFromDB } from './services/business.service.js';
import { loadTestBusiness } from './initializers/testBusiness.js';

const DB_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // re-sync every hour

async function start() {
  await connectDatabase();

  // Load real businesses from MongoDB (all completed AI setups)
  await loadBusinessesFromDB();

  // Also load the .env test business in development
  if (env.nodeEnv !== 'production') {
    loadTestBusiness();
  }

  // Periodic refresh — picks up newly connected businesses and refreshed tokens
  setInterval(
    () => loadBusinessesFromDB().catch((err) => logger.error('[Business] Refresh failed:', err)),
    DB_REFRESH_INTERVAL_MS,
  );

  app.listen(env.port, () => {
    logger.info(`🚀 Staffly AI running on port ${env.port} [${env.nodeEnv}]`);
    logger.info(`   Webhook URL : ${env.baseUrl}/webhook`);
    logger.info(`   OAuth URL   : ${env.baseUrl}/auth/meta/callback`);
    logger.info(`   Velte events: ${env.baseUrl}/api/velte/webhook`);
  });
}

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
