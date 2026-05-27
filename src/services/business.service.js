import { AISetup } from '../models/mongoose/AISetup.js';
import { User } from '../models/mongoose/User.js';
import { addBusiness, getBusinessByPhoneNumberId, updateBusiness } from '../models/Business.js';
import { logger } from '../utils/logger.js';

export async function loadBusinessesFromDB() {
  const setups = await AISetup.find({ isComplete: true }).select('+metaAccessToken').lean();

  if (!setups.length) {
    logger.info('[Business] No complete AI setups found in MongoDB');
    return;
  }

  let loaded = 0;
  let refreshed = 0;

  for (const setup of setups) {
    if (!setup.selectedNumberId || !setup.metaAccessToken) continue;

    const aiConfig = {
      enabled: setup.aiConfig?.enabled ?? false,
      greetingMessage: setup.aiConfig?.greetingMessage || '',
      businessTone: setup.aiConfig?.businessTone || '',
    };

    // If already in memory (e.g. from a previous load), just refresh token + config
    const existing = getBusinessByPhoneNumberId(setup.selectedNumberId);
    if (existing && !existing.is_test) {
      updateBusiness(existing.id, {
        access_token: setup.metaAccessToken,
        aiConfig,
      });
      refreshed++;
      continue;
    }

    const user = await User.findById(setup.userId).lean();
    if (!user) continue;

    addBusiness({
      id: `biz_${setup._id}`,
      name: user.company?.name || user.name || 'Unnamed Business',
      phone_number_id: setup.selectedNumberId,
      waba_id: setup.wabaId,
      access_token: setup.metaAccessToken,
      velteUserId: setup.userId.toString(),
      aiConfig,
    });

    loaded++;
  }

  if (loaded || refreshed) {
    logger.info(`[Business] DB sync — ${loaded} loaded, ${refreshed} refreshed`);
  }
}
