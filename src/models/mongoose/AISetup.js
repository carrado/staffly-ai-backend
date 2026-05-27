import mongoose from 'mongoose';

const AISetupSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metaAccessToken: { type: String, select: false },
    metaAccessTokenExpiresAt: Date,
    wabaId: String,
    selectedNumberId: String,
    aiConfig: {
      enabled: { type: Boolean, default: false },
      greetingMessage: String,
      businessTone: String,
    },
    isComplete: { type: Boolean, default: false },
  },
  { collection: 'aisetups', timestamps: true },
);

export const AISetup = mongoose.models.AISetup || mongoose.model('AISetup', AISetupSchema);
