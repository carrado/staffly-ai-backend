import express from "express";
import {
  searchProducts,
  searchStores,
  logSearch,
} from "../controllers/search/search.controller.js";
import {
  ensureConversation,
  appendTurn,
  getConversation,
  markHandoff,
} from "../controllers/search/conversations.controller.js";
import { listCategorySchemas } from "../controllers/search/categorySchemas.controller.js";

const router = express.Router();

// Public — called by the frontend's /api/search route, no session required.
router.post("/products", searchProducts);
router.post("/stores", searchStores);
router.post("/log", logSearch);

// Clarifying-question schema overrides (Phase 2 of the frontend's
// docs/velte-ai-search-flow-plan.md) — read-only here; writes live behind
// /api/internal (see internal.routes.js).
router.get("/category-schemas", listCategorySchemas);

// Persisted conversations + shopping task (Phase 1 of the frontend's
// docs/velte-ai-search-flow-plan.md) — same public trust model as the
// search endpoints above; ownership is the caller's own deviceId.
router.post("/conversations/ensure", ensureConversation);
router.post("/conversations/:id/turns", appendTurn);
router.post("/conversations/:id/handoff", markHandoff);
router.get("/conversations/:id", getConversation);

// Deliberately NOT here: POST /lead (wallet billing on "Chat on WhatsApp").
// That stays mounted at velte-backend's /api/search/lead — the frontend
// calls it there directly via sendBeacon, never through this service. See
// this repo's README for why lead billing wasn't migrated.

export default router;
