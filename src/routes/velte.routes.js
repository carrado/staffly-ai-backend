import { Router } from 'express';
import { verifyVelteSignature } from '../middleware/velte.signature.js';
import { handleVelteEvent } from '../controllers/velte.controller.js';

const router = Router();

router.post('/webhook', verifyVelteSignature, handleVelteEvent);

export default router;
