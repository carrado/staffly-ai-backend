/**
 * Abandoned-checkout follow-up sweeper.
 *
 * When a payment link is generated, runCheckout arms `session.pendingFollowUp`.
 * If the customer pays (payment webhook) or sends any further message (handled
 * at the top of handleIncomingMessage), it's cleared. Whatever is left armed and
 * untouched for ~1 hour is a genuine abandonment — this sweeper sends one polite,
 * language-aware nudge and marks it so it never repeats.
 */

import { ConversationSession } from '../models/mongoose/ConversationSession.js';
import {
  hydrateSession,
  getSession,
  markFollowUpSent,
} from '../models/ConversationState.js';
import { getBusinessById } from '../models/Business.js';
import { getOrderById } from '../models/Order.js';
import * as whatsapp from '../services/whatsapp.service.js';
import { generatePaymentFollowUp } from '../services/openai.service.js';
import { logger } from '../utils/logger.js';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // scan every 10 minutes
const ABANDON_AFTER_MS = 60 * 60 * 1000;  // nudge after ~1 hour of silence

async function sweep() {
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS);

  let due;
  try {
    due = await ConversationSession.find({
      'state.pendingFollowUp.orderId': { $exists: true },
      'state.pendingFollowUp.sentAt': null,
      'state.pendingFollowUp.createdAt': { $lte: cutoff },
    }).lean();
  } catch (err) {
    logger.error(`[FollowUp] Query failed: ${err.message}`);
    return;
  }

  for (const doc of due) {
    const { businessId, customerNumber } = doc;
    try {
      // Re-read through the store so we see any change a concurrent message made
      // (e.g. the customer just came back and the follow-up was cancelled).
      await hydrateSession(businessId, customerNumber);
      const session = getSession(businessId, customerNumber);
      const fu = session.pendingFollowUp;

      if (!fu || fu.sentAt) continue; // cancelled or already sent
      if (new Date(fu.createdAt).getTime() > Date.now() - ABANDON_AFTER_MS) continue;

      // The order is now durable, so this check is authoritative across restarts.
      const order = await getOrderById(fu.orderId);
      if (order && order.status === 'paid') {
        await markFollowUpSent(businessId, customerNumber);
        continue;
      }

      const business = getBusinessById(businessId);
      if (!business) continue; // business disconnected — skip silently

      const language = session.language || 'english';
      const message = await generatePaymentFollowUp(
        business,
        fu.productName,
        fu.amount,
        language,
      );

      await whatsapp.sendTextMessage(
        business.phone_number_id,
        business.access_token,
        customerNumber,
        message,
      );

      await markFollowUpSent(businessId, customerNumber, message);
      logger.info(
        `[FollowUp] Sent payment reminder to ${customerNumber} for "${fu.productName}"`,
      );
    } catch (err) {
      logger.error(`[FollowUp] Failed for ${customerNumber}: ${err.message}`);
    }
  }
}

export function startPaymentFollowUps() {
  const timer = setInterval(() => {
    sweep().catch((err) => logger.error(`[FollowUp] Sweep error: ${err.message}`));
  }, CHECK_INTERVAL_MS);
  timer.unref?.(); // never keep the process alive just for the sweeper

  logger.info(
    `[FollowUp] Abandoned-checkout sweeper started (every ${CHECK_INTERVAL_MS / 60000} min, nudge after ${ABANDON_AFTER_MS / 60000} min)`,
  );
}
