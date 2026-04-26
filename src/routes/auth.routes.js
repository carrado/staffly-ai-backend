import { Router } from 'express';
import {
  handleMetaCallback,
  disconnectBusiness,
  listBusinesses,
} from '../controllers/auth.controller.js';

const router = Router();

// Called by Meta after a business owner completes Embedded Signup
router.get('/meta/callback', handleMetaCallback);

// Dashboard: list all connected businesses (protect with auth in production!)
router.get('/businesses', listBusinesses);

// Business owner disconnects their WhatsApp
router.delete('/businesses/:businessId', disconnectBusiness);

export default router;
