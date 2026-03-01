import { logger } from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
}