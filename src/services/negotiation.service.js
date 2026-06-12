import { setSession } from '../models/ConversationState.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PRICE_STEP = 500;            // round counters to a clean, human number
const MAX_ROUNDS = 4;              // after this many rounds, accept any in-range offer
const MAX_BELOW_FLOOR_ROUNDS = 3;  // sub-floor bids that earn a counter before the floor becomes the final price
// How far ABOVE the customer's offer (toward the list price) we counter, per
// round. Anchored high on round 1, stepping down toward the customer each round.
const IN_RANGE_FRACTIONS = [0.7, 0.45, 0.25];
// When the offer is below the hidden floor, the counter keeps this fraction of
// the (list − floor) gap above the floor: round 1 is a small cut off the list
// price, each press earns a deeper one, but no counter ever lands near the
// floor. When the schedule runs out, the floor itself is quoted as FINAL.
const BELOW_FLOOR_FRACTIONS = [0.85, 0.6, 0.4];
// Fallback floor when a product is negotiable but has no explicit minimum.
const DEFAULT_FLOOR_RATIO = 0.9;

const roundToStep = (n) => Math.round(n / PRICE_STEP) * PRICE_STEP;

function resolveFloor(product) {
  const explicit = Number(product.min_price);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return roundToStep(Number(product.price) * DEFAULT_FLOOR_RATIO);
}

export function startNegotiation(businessId, customerNumber, product) {
  const negotiation = {
    productId: product.id,
    productName: product.name,
    originalPrice: product.price,
    // Hidden floor — the minimum acceptable price. NEVER surface this to the
    // model or the customer. Only the server's algorithm may read it.
    minPrice: resolveFloor(product),
    currentOffer: null,
    lastCounter: null,
    rounds: 0,
    belowFloorRounds: 0,
    stage: 'started',
  };
  setSession(businessId, customerNumber, { negotiation });
  return negotiation;
}

/**
 * Decide how to respond to a customer's offer. The floor stays hidden while
 * there is still room to haggle; it is only ever surfaced as the FINAL price
 * once the customer has pressed without reaching it.
 * Pure function: returns the decision plus the next negotiation state to persist.
 *
 *   outcome 'accept'  → close the deal at acceptedPrice (hand off to checkout)
 *   outcome 'counter' → counter at counterPrice (model justifies with real qualities)
 *   outcome 'final'   → quote finalPrice (the floor) as the take-it-or-leave-it price
 */
export function evaluateOffer(negotiation, rawOffer) {
  const offer = Number(rawOffer);
  const list = negotiation.originalPrice;
  const floor = negotiation.minPrice;
  const prevOffer = Number.isFinite(negotiation.currentOffer) ? negotiation.currentOffer : null;
  const rounds = (negotiation.rounds || 0) + 1;

  const base = { ...negotiation, currentOffer: offer, rounds };

  // 1. At or above the list price → accept at the list price.
  if (offer >= list) {
    return {
      outcome: 'accept',
      acceptedPrice: list,
      negotiation: { ...base, lastCounter: null, stage: 'accepted' },
    };
  }

  // 2. In range: floor <= offer < list.
  if (offer >= floor) {
    const lastQuoted = Number.isFinite(negotiation.lastCounter) ? negotiation.lastCounter : null;

    // The customer has met (or beaten) a price we already quoted — including a
    // declared FINAL price. Close at our quote; never charge above it.
    if (lastQuoted !== null && offer >= lastQuoted) {
      return {
        outcome: 'accept',
        acceptedPrice: lastQuoted,
        negotiation: { ...base, lastCounter: null, stage: 'accepted' },
      };
    }

    const tolerance = Math.max(PRICE_STEP, Math.round(list * 0.01));
    const heldFirm = prevOffer !== null && Math.abs(offer - prevOffer) <= tolerance;

    // Customer is holding firm at a price we can live with, or we've haggled
    // long enough — take the deal at their number to recover the sale.
    if (heldFirm || rounds > MAX_ROUNDS) {
      return {
        outcome: 'accept',
        acceptedPrice: offer,
        negotiation: { ...base, lastCounter: null, stage: 'accepted' },
      };
    }

    const fraction = IN_RANGE_FRACTIONS[Math.min(rounds - 1, IN_RANGE_FRACTIONS.length - 1)];
    let counter = roundToStep(offer + (list - offer) * fraction);
    // Each press earns movement: stay below our previous quote.
    if (lastQuoted !== null) counter = Math.min(counter, lastQuoted - PRICE_STEP);
    // Strictly between the offer and the list price, never below the floor.
    counter = Math.max(counter, offer + PRICE_STEP, floor);
    counter = Math.min(counter, list - PRICE_STEP);
    if (counter <= offer) counter = Math.min(offer + PRICE_STEP, list);

    // The clamps couldn't find a number below our previous quote — there is no
    // meaningful counter left, so close at the customer's (in-range) offer.
    if (lastQuoted !== null && counter >= lastQuoted) {
      return {
        outcome: 'accept',
        acceptedPrice: offer,
        negotiation: { ...base, lastCounter: null, stage: 'accepted' },
      };
    }

    return {
      outcome: 'counter',
      counterPrice: counter,
      negotiation: { ...base, lastCounter: counter, stage: 'countered' },
    };
  }

  // 3. Below the floor → cannot accept at their number.
  const belowFloorRounds = (negotiation.belowFloorRounds || 0) + 1;

  // The floor becomes the open, take-it-or-leave-it final price — capped at
  // anything we already quoted: a stated price is a commitment and the final
  // price must NEVER be higher than a number the customer has already seen.
  // lastCounter is set to it so a plain "ok" afterwards checks out at exactly
  // this price.
  const standingQuote = Number.isFinite(negotiation.lastCounter) ? negotiation.lastCounter : null;
  const finalPrice = standingQuote !== null ? Math.min(floor, standingQuote) : floor;
  const finalDecision = {
    outcome: 'final',
    finalPrice,
    negotiation: { ...base, belowFloorRounds, lastCounter: finalPrice, stage: 'final' },
  };

  // They've pressed enough without reaching the floor — stop descending.
  if (belowFloorRounds > MAX_BELOW_FLOOR_ROUNDS) return finalDecision;

  // Too little room between floor and list to stage a descent.
  if (list - floor <= PRICE_STEP * 2) return finalDecision;

  const fraction =
    BELOW_FLOOR_FRACTIONS[Math.min(belowFloorRounds - 1, BELOW_FLOOR_FRACTIONS.length - 1)];
  let counter = roundToStep(floor + (list - floor) * fraction);

  // Every press earns a real (but shrinking) concession: strictly below our
  // previous counter, below the list price, and never near the floor.
  if (standingQuote !== null) counter = Math.min(counter, standingQuote - PRICE_STEP);
  counter = Math.min(counter, list - PRICE_STEP);

  // No room left above the floor — the descent is over; the floor is final.
  if (counter < floor + PRICE_STEP) return finalDecision;

  return {
    outcome: 'counter',
    counterPrice: counter,
    negotiation: { ...base, belowFloorRounds, lastCounter: counter, stage: 'countered' },
  };
}
