import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { loadTestBusiness } from './initializers/testBusiness.js';

const PORT = env.port;

// Load test business from environment variables
loadTestBusiness();

app.listen(PORT, () => {
  logger.info(`🚀 Staffly AI running on port ${PORT}`);
});