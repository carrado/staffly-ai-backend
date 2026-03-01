import { addBusiness } from '../models/Business.js';
import { logger } from '../utils/logger.js';

export function loadTestBusiness() {
  const phoneNumberId = process.env.TEST_PHONE_NUMBER_ID;
  const wabaId = process.env.TEST_WABA_ID;
  const accessToken = process.env.TEST_ACCESS_TOKEN;

  if (phoneNumberId && wabaId && accessToken) {
    const business = addBusiness({
      id: 'biz_demo',
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: accessToken,
    });
    logger.info('✅ Test business loaded:', business.id);
  } else {
    logger.warn('⚠️ No test business configured – skipping.');
  }
}