// Shared-secret guard for service-to-service calls (velte-backend calling
// into this repo) — this endpoint is deliberately NOT public, unlike
// /api/search/*, so no buyer session/JWT applies here, just a header check
// against an env var both repos hold (INTERNAL_SERVICE_SECRET).
export function verifyInternalSecret(req, res, next) {
  const provided = req.headers["x-internal-secret"];
  const expected = process.env.INTERNAL_SERVICE_SECRET;

  if (!expected) {
    console.error(
      "[internalAuth] INTERNAL_SERVICE_SECRET is not configured — rejecting all internal calls.",
    );
    return res.status(503).json({ success: false, message: "Service not configured." });
  }
  if (provided !== expected) {
    return res.status(401).json({ success: false, message: "Not authenticated." });
  }
  next();
}
