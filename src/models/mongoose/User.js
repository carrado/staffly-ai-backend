import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
    company: {
      name: String,
      phone: String,
      location: String,
    },
    businessType: String,
    activeStatus: { type: Boolean, default: true },
  },
  { collection: 'users' },
);

export const User = mongoose.models.User || mongoose.model('User', UserSchema);
