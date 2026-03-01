import { env } from "../config/env.js";

// In production, replace with a database.
const businesses = [
  {
    waba_id: 1428158388183193,
    phone_number_id: 976297892242222,
    access_token: env.metaAccessToken,
  }
];

export const addBusiness = (businessData) => {
  const business = { id: `biz_${Date.now()}`, ...businessData };
  businesses.push(business);
  return business;
};

export const getBusinessByPhoneNumberId = (phoneNumberId) => {
  return businesses.find(b => b.phone_number_id === phoneNumberId);
};

export const getBusinessById = (id) => businesses.find(b => b.id === id);

export const updateBusinessToken = (id, accessToken) => {
  const business = getBusinessById(id);
  if (business) business.access_token = accessToken;
};