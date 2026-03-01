import { Router } from 'express';
import { handleMetaCallback } from '../controllers/auth.controller.js';

const router = Router();

router.get('/meta/callback', handleMetaCallback);

export default router;