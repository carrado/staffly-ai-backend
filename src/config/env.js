import dotenv from 'dotenv';
dotenv.config();

export const env = {
  port: process.env.PORT || 3000,
  openaiApiKey: process.env.OPENAI_API_KEY,
  metaAccessToken: process.env.META_ACCESS_TOKEN,
  metaAppSecret: process.env.META_APP_SECRET,
  metaAppId: process.env.META_APP_ID,
  metaVerifyToken: process.env.META_VERIFY_TOKEN,
  metaRedirectUri: process.env.META_REDIRECT_URI,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
};