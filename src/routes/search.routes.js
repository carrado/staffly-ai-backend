import express from "express";
import {
  searchProducts,
  searchStores,
  logSearch,
} from "../controllers/search/search.controller.js";

const router = express.Router();

// Public — called by the frontend's /api/search route, no session required.
router.post("/products", searchProducts);
router.post("/stores", searchStores);
router.post("/log", logSearch);

// Deliberately NOT here: POST /lead (wallet billing on "Chat on WhatsApp").
// That stays mounted at velte-backend's /api/search/lead — the frontend
// calls it there directly via sendBeacon, never through this service. See
// this repo's README for why lead billing wasn't migrated.

export default router;
