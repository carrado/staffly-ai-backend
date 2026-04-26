import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { loadTestBusiness } from './initializers/testBusiness.js';

// ── Load test/dev business from .env (skipped in production if vars not set) ──
if (env.nodeEnv !== 'production') {
  loadTestBusiness();
}

app.listen(env.port, () => {
  logger.info(`🚀 Staffly AI running on port ${env.port} [${env.nodeEnv}]`);
  logger.info(`   Webhook URL : ${env.baseUrl}/webhook`);
  logger.info(`   OAuth URL   : ${env.baseUrl}/auth/meta/callback`);
});
