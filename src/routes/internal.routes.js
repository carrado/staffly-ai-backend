import express from "express";
import { verifyInternalSecret } from "../middleware/internalAuth.js";
import { matchBuyerRequest } from "../controllers/internal/matchBuyerRequest.controller.js";

const router = express.Router();

router.use(verifyInternalSecret);
router.post("/match-buyer-request", matchBuyerRequest);

export default router;
