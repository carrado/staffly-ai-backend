import { logger } from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
}
