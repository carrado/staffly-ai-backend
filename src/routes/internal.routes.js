import express from "express";
import { verifyInternalSecret } from "../middleware/internalAuth.js";
import { matchBuyerRequest } from "../controllers/internal/matchBuyerRequest.controller.js";
import {
  upsertCategorySchema,
  deleteCategorySchema,
} from "../controllers/search/categorySchemas.controller.js";

const router = express.Router();

router.use(verifyInternalSecret);
router.post("/match-buyer-request", matchBuyerRequest);

// Clarifying-question schema overrides (Phase 2) — operator-only writes;
// the public read is GET /api/search/category-schemas.
router.put("/category-schemas", upsertCategorySchema);
router.delete("/category-schemas", deleteCategorySchema);

export default router;
