import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export async function connectDatabase() {
  await mongoose.connect(env.mongodbUri);
  logger.info('[DB] Connected to MongoDB');
}
