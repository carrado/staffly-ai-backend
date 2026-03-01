import express from 'express';
import webhookRoutes from './routes/webhook.routes.js';
import authRoutes from './routes/auth.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import { errorHandler } from './middleware/error.handler.js';

const app = express();

// Middleware
app.use(express.json());

// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth', authRoutes);
app.use('/api', paymentRoutes); // internal mock webhook

// Health check
app.get('/health', (req, res) => res.send('OK'));

// Error handling
app.use(errorHandler);

export default app;