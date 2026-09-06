import express from "express";
import { verifyInternalSecret } from "../middleware/internalAuth.js";
import { matchBuyerRequest } from "../controllers/internal/matchBuyerRequest.controller.js";
import { cheaperAlternative } from "../controllers/internal/cheaperAlternative.controller.js";
import {
  upsertCategorySchema,
  deleteCategorySchema,
} from "../controllers/search/categorySchemas.controller.js";

const router = express.Router();

router.use(verifyInternalSecret);
router.post("/match-buyer-request", matchBuyerRequest);
// The price-watch market check (2026-09-05) — velte-backend asks, just
// before it sends a drop alert, whether anyone on Velte has the same thing
// cheaper. See the controller for why an alert without this can leave the
// buyer worse off.
router.post("/cheaper-alternative", cheaperAlternative);

// Clarifying-question schema overrides (Phase 2) — operator-only writes;
// the public read is GET /api/search/category-schemas.
router.put("/category-schemas", upsertCategorySchema);
router.delete("/category-schemas", deleteCategorySchema);

export default router;
