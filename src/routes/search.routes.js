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
  listConversations,
  claimConversations,
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
// search endpoints above.
//
// Ownership was the caller's own deviceId alone until buyer chat history
// (2026-08-26) widened it to "this device OR this signed-in buyer" (see
// ownershipFilter), so an account's threads open on any browser they sign
// into. deviceId is still required on every call and is still the only
// owner an anonymous buyer ever has.
//
// The two literal paths MUST be declared before "/conversations/:id":
// Express matches in order, and "claim" would otherwise be swallowed by the
// :id route and fail as an invalid ObjectId.
router.post("/conversations/ensure", ensureConversation);
router.post("/conversations/claim", claimConversations);
router.get("/conversations", listConversations);
router.post("/conversations/:id/turns", appendTurn);
router.post("/conversations/:id/handoff", markHandoff);
router.get("/conversations/:id", getConversation);

// Deliberately NOT here: POST /lead (wallet billing on "Chat on WhatsApp").
// That stays mounted at velte-backend's /api/search/lead — the frontend
// calls it there directly via sendBeacon, never through this service. See
// this repo's README for why lead billing wasn't migrated.

export default router;
