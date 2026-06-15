import dotenv from 'dotenv';
dotenv.config();

export const env = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  mongodbUri: process.env.MONGODB_URI,

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Anthropic (Claude) — powers the action-decision classifier
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  // When true, the search ranker also "looks at" each product's photo (vision)
  // so poorly-described items are matched by how they actually look. Off by
  // default — it adds a one-time (cached) vision call per product.
  productVision: process.env.PRODUCT_VISION === 'true',

  // Meta / WhatsApp Platform credentials (YOUR app's credentials, not the businesses')
  metaAppId: process.env.META_APP_ID,
  metaAppSecret: process.env.META_APP_SECRET,
  metaVerifyToken: process.env.META_VERIFY_TOKEN,
  metaRedirectUri: process.env.META_REDIRECT_URI,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
};
