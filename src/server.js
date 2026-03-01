import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const PORT = env.port;

app.listen(PORT, () => {
  logger.info(`🚀 Staffly AI running on port ${PORT}`);
});