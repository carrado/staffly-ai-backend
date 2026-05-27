import dotenv from 'dotenv';
dotenv.config();

export const env = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  mongodbUri: process.env.MONGODB_URI,

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Meta / WhatsApp Platform credentials (YOUR app's credentials, not the businesses')
  metaAppId: process.env.META_APP_ID,
  metaAppSecret: process.env.META_APP_SECRET,
  metaVerifyToken: process.env.META_VERIFY_TOKEN,
  metaRedirectUri: process.env.META_REDIRECT_URI,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // Velte backend (event source)
  velteWebhookSecret: process.env.VELTE_WEBHOOK_SECRET,
  velteBaseUrl: process.env.NODE_ENV === 'production'
    ? 'https://velte-backend.onrender.com'
    : 'http://localhost:5000',

  // ─── Test / Dev business (loaded from .env for local testing) ───────────────
  // These simulate what would come from Embedded Signup for a real user.
  // Set these in .env to test without going through the full OAuth flow.
  testPhoneNumberId: process.env.TEST_PHONE_NUMBER_ID,
  testWabaId: process.env.TEST_WABA_ID,
  testAccessToken: process.env.TEST_ACCESS_TOKEN,
  testBusinessName: process.env.TEST_BUSINESS_NAME || 'Demo Store',
};
