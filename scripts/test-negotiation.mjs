import { evaluateOffer } from '../src/services/negotiation.service.js';

function simulate(label, list, floor, bids) {
  console.log(`\n=== ${label} (list ₦${list.toLocaleString()}, hidden floor ₦${floor.toLocaleString()}) ===`);
  let neg = {
    productId: 'p1', productName: 'Test', originalPrice: list, minPrice: floor,
    currentOffer: null, lastCounter: null, rounds: 0, belowFloorRounds: 0, stage: 'started',
  };
  for (const bid of bids) {
    const d = evaluateOffer(neg, bid);
    neg = d.negotiation;
    const detail =
      d.outcome === 'counter' ? `counter ₦${d.counterPrice.toLocaleString()}` :
      d.outcome === 'accept' ? `accept  ₦${d.acceptedPrice.toLocaleString()}` :
      `FINAL   ₦${d.finalPrice.toLocaleString()}`;
    console.log(`bid ₦${bid.toLocaleString().padStart(7)} → ${detail}`);
  }
}

// Lowballer pressing harder each round but never reaching the floor
simulate('Persistent lowballer', 50000, 40000, [20000, 25000, 30000, 32000, 33000]);

// Lowballer who gives in and meets the revealed final price
simulate('Gives in at final price', 50000, 40000, [20000, 25000, 30000, 32000, 40000]);

// Normal in-range haggle (unchanged behavior)
simulate('In-range haggle', 50000, 40000, [42000, 45000, 45000]);

// Tiny gap between floor and list — no room to stage a descent
simulate('Tiny gap', 10000, 9500, [7000, 9500]);

// No explicit min_price product → default floor 90% of list (45,000)
simulate('Default floor', 50000, 45000, [30000, 35000, 40000, 42000]);
