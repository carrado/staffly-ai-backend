import mongoose from 'mongoose';

/**
 * Persisted conversation session — the durable backing store for the in-memory
 * session cache in `models/ConversationState.js`. One document per
 * `businessId:customerNumber` pair.
 *
 * The whole session blob (conversationHistory, lastProduct, lastSearch,
 * negotiation, language, shownProductIds, lastMessageAt, ...) lives in `state`
 * as a Mixed field so the shape can evolve without migrations. `lastMessageAt`
 * is duplicated at the top level purely so we can index it for the TTL sweep.
 */
const ConversationSessionSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true },
    customerNumber: { type: String, required: true },
    state: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastMessageAt: { type: Date },
  },
  { collection: 'conversationsessions', timestamps: true, minimize: false },
);

ConversationSessionSchema.index({ businessId: 1, customerNumber: 1 }, { unique: true });

// Sweep abandoned sessions after 30 days of silence so the collection cannot
// grow unbounded. Absence detection only cares about gaps of an hour or two, so
// a month-old session has no live value worth keeping.
ConversationSessionSchema.index(
  { lastMessageAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

export const ConversationSession =
  mongoose.models.ConversationSession ||
  mongoose.model('ConversationSession', ConversationSessionSchema);
