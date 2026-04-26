import { getSession, setSession } from '../models/ConversationState.js';

export function startNegotiation(businessId, customerNumber, product) {
  setSession(businessId, customerNumber, {
    negotiation: {
      productId: product.id,
      productName: product.name,
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
  const updated = { ...session.negotiation, currentOffer: offer, stage: 'offered' };
  setSession(businessId, customerNumber, { ...session, negotiation: updated });
  return updated;
}

export function isAccepted(minPrice, offer) {
  return offer >= minPrice;
}

export function calculateCounter(originalPrice, minPrice) {
  // Midpoint counter-offer
  return Math.floor((originalPrice + minPrice) / 2);
}
