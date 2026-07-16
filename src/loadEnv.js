// Must be the very first thing app.js imports, and nothing else — same
// ordering requirement as velte-backend's own loadEnv.js (ES modules
// evaluate all static imports before any top-level statement runs, so a
// later-imported module that reads process.env at load time, e.g.
// pushNotification.service.js's VAPID setup, must not be imported before
// this has run).
import dotenv from "dotenv-flow";

dotenv.config();
