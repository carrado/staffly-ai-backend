import "./loadEnv.js";

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import searchRoutes from "./routes/search.routes.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const app = express();

// Same reasoning as velte-backend's app.js: exactly one reverse proxy hop on
// the deploy target, so trust exactly one — never `true` (spoofable).
app.set("trust proxy", 1);

app.use(helmet());
app.use(hpp());

const env = process.env.NODE_ENV || "development";

// Same origin allowlist as velte-backend — this service is only ever called
// from the same frontend, never directly by anything else.
app.use(
  cors({
    origin: [
      "http://localhost:4001",
      "https://velte-dev.vercel.app",
      "https://velte.ng",
    ],
    credentials: true,
  }),
);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(mongoSanitize());

// Search is a public, unauthenticated, higher-traffic surface than the
// vendor dashboard API by design (that's the whole point of the split) — a
// higher ceiling than velte-backend's 100/15min, but still bounded.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  }),
);

// Same MongoDB, same URI-selection rule as velte-backend (localhost +
// staging share one DB; only production has its own) — this service reads
// velte-backend's Product/Store/User/Wallet collections directly and writes
// its own search-domain collections (VendorExposure, RecruitmentLead,
// Notification) into the same cluster.
const dbUri =
  env === "production" ? process.env.MONGODB_URI_PRODUCTION : process.env.MONGODB_URI;

mongoose
  .connect(dbUri)
  .then(() => console.log(`✅ Connected to MongoDB (${env})`))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

app.use("/api/search", searchRoutes);

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "staffly-ai-backend",
    environment: env,
    database: env === "production" ? "Production DB" : "Staging DB",
    timestamp: new Date().toISOString(),
  });
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 7100;
app.listen(PORT, () => {
  console.log(`🚀 staffly-ai-backend running on port ${PORT} (${env})`);
});
