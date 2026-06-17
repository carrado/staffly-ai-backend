import { setSession } from '../models/ConversationState.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PRICE_STEP = 500;            // round counters to a clean, human number
const MAX_ROUNDS = 4;              // after this many rounds, accept any in-range offer
const MAX_BELOW_FLOOR_ROUNDS = 3;  // sub-floor bids that earn a counter before we hold firm
const MAX_CONCEDE_ROUNDS = 3;      // no-number "reduce am" presses that earn a cut before we hold firm
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

// When the customer asks for a discount WITHOUT naming a number ("abeg reduce
// am", "do better", "how much last?"), each press steps our quote this fraction
// of the way from our current anchor down toward the hidden floor — a real but
// shrinking concession that never reaches the floor until the descent is spent.
const CONCESSION_FRACTION = 0.4;

/**
 * Once a price has been declared FINAL it is locked: the haggling is over. The
 * final price is whatever we last quoted (`lastCounter`) — we never drop below it
 * again, and never raise it. Meeting or beating it closes the deal at that exact
 * number; any lower press is gently held at the SAME final price. `offer` is the
 * customer's number, or NaN for a no-number press ("abeg do better").
 */
function holdFinal(negotiation, offer) {
  const finalPrice = negotiation.lastCounter;
  if (Number.isFinite(offer) && offer >= finalPrice) {
    return {
      outcome: 'accept',
      acceptedPrice: finalPrice,
      negotiation: { ...negotiation, currentOffer: offer, lastCounter: null, stage: 'accepted' },
    };
  }
  return {
    outcome: 'final',
    finalPrice,
    negotiation: {
      ...negotiation,
      ...(Number.isFinite(offer) ? { currentOffer: offer } : {}),
    },
  };
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
    concedeRounds: 0,
    stage: 'started',
  };
  setSession(businessId, customerNumber, { negotiation });
  return negotiation;
}

/**
 * Respond to a discount request that carries NO number (the customer is pressing
 * us to come down, but hasn't named a price). We make the move ourselves: an
 * opening offer below the list price, then a deeper cut each time they press —
 * always strictly below our previous quote and never below the hidden floor.
 * After MAX_CONCEDE_ROUNDS cuts (or when there's no room left to move without
 * breaching the floor), we stop dropping and hold the LAST price we quoted as the
 * take-it-or-leave-it FINAL price — never a deeper, freshly-revealed number.
 *
 *   outcome 'counter' → quote counterPrice (model justifies with real qualities)
 *   outcome 'final'   → quote finalPrice (the last counter) as the final price
 */
export function concede(negotiation) {
  // Already final — restate the same price, never drop further.
  if (negotiation.stage === 'final' && Number.isFinite(negotiation.lastCounter)) {
    return holdFinal(negotiation, NaN);
  }

  const list = negotiation.originalPrice;
  const floor = negotiation.minPrice;
  const rounds = (negotiation.rounds || 0) + 1;
  const concedeRounds = (negotiation.concedeRounds || 0) + 1;
  const base = { ...negotiation, rounds, concedeRounds };
  const lastQuoted = Number.isFinite(negotiation.lastCounter) ? negotiation.lastCounter : null;

  // Hold the last price we quoted as final; fall back to the floor only if we
  // never managed to quote a counter at all.
  const finalPrice = lastQuoted !== null ? lastQuoted : floor;
  const finalDecision = {
    outcome: 'final',
    finalPrice,
    negotiation: { ...base, lastCounter: finalPrice, stage: 'final' },
  };

  // Pressed past the concession budget — hold the last quote as final.
  if (concedeRounds > MAX_CONCEDE_ROUNDS) return finalDecision;

  // No meaningful room between list and floor — just hold firm.
  if (list - floor <= PRICE_STEP) return finalDecision;

  // Step down from wherever we last stood (the list price on the first press)
  // toward the floor.
  const anchor = lastQuoted !== null ? lastQuoted : list;
  let counter = roundToStep(anchor - (anchor - floor) * CONCESSION_FRACTION);

  // Each press must beat our previous quote, stay under the list, and never dip
  // below the floor.
  if (lastQuoted !== null) counter = Math.min(counter, lastQuoted - PRICE_STEP);
  counter = Math.min(counter, list - PRICE_STEP);
  counter = Math.max(counter, floor);

  // Can't move below our last quote without hitting the floor → floor is final.
  if (counter <= floor || (lastQuoted !== null && counter >= lastQuoted)) return finalDecision;

  return {
    outcome: 'counter',
    counterPrice: counter,
    negotiation: { ...base, lastCounter: counter, stage: 'countered' },
  };
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

  // Already final — the price is locked. Meet it to close, otherwise hold firm.
  if (negotiation.stage === 'final' && Number.isFinite(negotiation.lastCounter)) {
    return holdFinal(negotiation, offer);
  }

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

  // The LAST price we quoted becomes the take-it-or-leave-it final price — we hold
  // it firm rather than revealing a deeper floor. A stated price is a commitment,
  // so the final price is exactly that number (always at or above the hidden
  // floor); only if we never quoted a counter does the floor itself stand in.
  // lastCounter is set to it so a plain "ok" afterwards checks out at exactly
  // this price.
  const standingQuote = Number.isFinite(negotiation.lastCounter) ? negotiation.lastCounter : null;
  const finalPrice = standingQuote !== null ? standingQuote : floor;
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
