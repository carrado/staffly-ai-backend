import dotenv from "dotenv";
dotenv.config();

export const env = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",

  // Database
  mongodbUri: process.env.MONGODB_URI,

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Anthropic (Claude) — powers the action-decision classifier
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  // When true, the search ranker also "looks at" each product's photo (vision)
  // so poorly-described items are matched by how they actually look. Off by
  // default — it adds a one-time (cached) vision call per product.
  productVision: process.env.PRODUCT_VISION === "true",

  // Shared secret for verifying webhooks dispatched by velte-backend
  // (HMAC-SHA256 over the raw body, sent as the `x-velte-signature` header).
  // Must match velte-backend's VELTE_WEBHOOK_SECRET. Reused (same shared secret) to
  // SIGN staffly → velte calls with the `x-staffly-signature` header.
  velteWebhookSecret: process.env.VELTE_WEBHOOK_SECRET,

  // velte-backend API base (e.g. http://localhost:5000/api) — staffly posts the
  // manual-transfer order bridge to `${velteApiUrl}/internal/orders/from-staffly`.
  velteApiUrl: process.env.VELTE_API_URL,

  // At or above this order total (₦), a verified manual-transfer receipt is NOT
  // auto-confirmed — it's held for the vendor to confirm against their bank alert
  // in the velte dashboard. New buyers are always held regardless of amount.
  // Lower it to push more receipts through human confirmation (less fraud risk,
  // more vendor work); raise it to auto-confirm more (more convenience, more risk).
  receiptVendorConfirmOver: Number(
    process.env.RECEIPT_VENDOR_CONFIRM_OVER || 100000,
  ),

  // Meta / WhatsApp Platform credentials (YOUR app's credentials, not the businesses')
  metaAppId: process.env.META_APP_ID,
  metaAppSecret: process.env.META_APP_SECRET,
  metaVerifyToken: process.env.META_VERIFY_TOKEN,
  metaRedirectUri: process.env.META_REDIRECT_URI,
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
};
