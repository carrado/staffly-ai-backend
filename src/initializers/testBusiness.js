/**
 * Test Business Initializer
 *
 * Loads a single test business from .env variables so you can develop and test
 * locally WITHOUT going through Meta's Embedded Signup flow.
 *
 * In production, all businesses connect via the OAuth/Embedded Signup route.
 * This file is only used in development.
 *
 * Required .env variables:
 *   TEST_PHONE_NUMBER_ID   — your WhatsApp phone number ID from Meta dashboard
 *   TEST_WABA_ID           — your WhatsApp Business Account ID
 *   TEST_ACCESS_TOKEN      — your long-lived access token
 *   TEST_BUSINESS_NAME     — (optional) display name, defaults to "Demo Store"
 */

import { addBusiness, getBusinessByPhoneNumberId } from '../models/Business.js';
import { seedDemoProducts } from '../models/Products.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export function loadTestBusiness() {
  const { testPhoneNumberId, testWabaId, testAccessToken, testBusinessName } = env;

  if (!testPhoneNumberId || !testWabaId || !testAccessToken) {
    logger.warn('⚠️  No test business configured — skipping. Set TEST_PHONE_NUMBER_ID, TEST_WABA_ID, TEST_ACCESS_TOKEN in .env to enable.');
    return null;
  }

  // Avoid duplicate registration on hot-reload
  const existing = getBusinessByPhoneNumberId(testPhoneNumberId);
  if (existing) {
    logger.info(`✅ Test business already loaded: ${existing.id}`);
    return existing;
  }

  const business = addBusiness({
    id: 'biz_test',
    name: testBusinessName,
    phone_number_id: testPhoneNumberId,
    waba_id: testWabaId,
    access_token: testAccessToken,
    is_test: true,
  });

  // Seed demo products so the AI has something to work with
  seedDemoProducts(business.id);

  logger.info(`✅ Test business loaded: "${business.name}" (${business.id})`);
  logger.info(`   Phone Number ID : ${testPhoneNumberId}`);
  logger.info(`   WABA ID         : ${testWabaId}`);
  return business;
}
