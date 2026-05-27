import express from 'express';
import webhookRoutes from './routes/webhook.routes.js';
import authRoutes from './routes/auth.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import velteRoutes from './routes/velte.routes.js';
import { errorHandler } from './middleware/error.handler.js';

const app = express();

app.use(express.json({
    /**
     * The verify function allows us to intercept the raw request body.
     * @param req The request object
     * @param res The response object
     * @param buf A Buffer of the raw request body
     * @param encoding The encoding of the request
     */
    verify: (req, res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf;
      }
    }
  }));

  
// ── Routes ────────────────────────────────────────────────────────────────────
// Single webhook endpoint handles messages for ALL connected businesses.
// Meta routes all messages here; we use phone_number_id to identify the business.
app.use('/webhook', webhookRoutes);

// Embedded Signup OAuth callback + business management
app.use('/auth', authRoutes);

// Payment gateway webhook
app.use('/api', paymentRoutes);

// Velte backend event webhook
app.use('/api/velte', velteRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Error handler
app.use(errorHandler);

export default app;
