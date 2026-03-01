import { getSession, setSession } from '../models/ConversationState.js';

export function startNegotiation(businessId, customerNumber, product) {
  setSession(businessId, customerNumber, {
    negotiation: {
      productId: product.id,
      originalPrice: product.price,
      minPrice: product.min_price,
      currentOffer: null,
      stage: 'started',
    },
  });
}

export function updateNegotiation(businessId, customerNumber, offer) {
  const session = getSession(businessId, customerNumber);
  if (!session.negotiation) return null;
  session.negotiation.currentOffer = offer;
  session.negotiation.stage = 'offered';
  setSession(businessId, customerNumber, session);
  return session.negotiation;
}

export function isAccepted(originalPrice, minPrice, offer) {
  return offer >= minPrice;
}

export function calculateCounter(originalPrice, minPrice) {
  // Simple counter: midpoint between min and original
  return Math.floor((originalPrice + minPrice) / 2);
}