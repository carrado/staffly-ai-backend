/**
 * Product Change Stream — instant cache invalidation
 *
 * Vendors add/edit/remove products on the Velte platform, which writes directly
 * to the shared `products` collection. This backend only READS that collection
 * (cached per-business for ~5 min in product.service). Without a signal, a new
 * or changed product would take up to that TTL to reach customers.
 *
 * A MongoDB change stream on the collection lets us invalidate the affected
 * business's cache the instant a product changes — so additions, edits, price
 * changes, and stock movements (stockQuantity/orderedQuantity, which Velte
 * updates as orders come in) surface to customers right away instead of waiting
 * out the TTL.
 *
 * Change streams require a replica set (MongoDB Atlas provides one). On a
 * standalone server the stream errors out — we log it once and fall back to the
 * existing TTL refresh, so the app still works, just without instant updates.
 */

import { Product } from '../models/mongoose/Product.js';
import { getBusinessByVelteUserId } from '../models/Business.js';
import {
  invalidateProductCache,
  invalidateAllProductCaches,
} from '../services/product.service.js';
import { logger } from '../utils/logger.js';

const RESTART_DELAY_MS = 10 * 1000; // wait before re-watching after a transient error

let changeStream = null;
let stopped = false;

// A standalone mongod can't serve change streams. Detect that specific failure
// so we stop retrying (TTL refresh covers us) instead of looping forever.
function isUnsupported(err) {
  return (
    err?.code === 40573 ||
    /only supported on replica sets|replica set/i.test(err?.message || '')
  );
}

function handleChange(change) {
  try {
    // Deletes carry only the document key (no body, so no vendorId). They're
    // rare, so clear every product cache rather than miss the removal — each
    // business's next search simply re-reads fresh from Mongo.
    if (change.operationType === 'delete') {
      invalidateAllProductCaches();
      logger.info('[ProductSync] Product deleted — cleared all product caches');
      return;
    }

    const vendorId = change.fullDocument?.vendorId;
    if (!vendorId) return;

    const business = getBusinessByVelteUserId(vendorId);
    if (!business) return; // no loaded business for this vendor → nothing cached

    invalidateProductCache(business.id);
    logger.info(
      `[ProductSync] ${change.operationType} on a product → invalidated cache for ${business.name} (${business.id})`,
    );
  } catch (err) {
    logger.error(`[ProductSync] Failed to handle change: ${err.message}`);
  }
}

function safeClose() {
  const cs = changeStream;
  changeStream = null;
  if (!cs) return;
  cs.removeAllListeners();
  cs.close().catch(() => {}); // best-effort; may already be closed
}

function watch() {
  if (stopped) return;

  // updateLookup attaches the full document (incl. vendorId) to update events,
  // not just the changed fields — so any change maps back to its business.
  changeStream = Product.watch([], { fullDocument: 'updateLookup' });

  changeStream.on('change', handleChange);

  changeStream.on('error', (err) => {
    safeClose();

    if (isUnsupported(err)) {
      stopped = true; // don't retry — the TTL refresh keeps data fresh
      logger.warn(
        `[ProductSync] Change streams need a replica set — falling back to ~5-min TTL refresh (${err.message})`,
      );
      return;
    }

    logger.error(
      `[ProductSync] Change stream error — restarting in ${RESTART_DELAY_MS / 1000}s: ${err.message}`,
    );
    setTimeout(watch, RESTART_DELAY_MS);
  });

  logger.info('[ProductSync] Watching products collection for changes');
}

export function startProductSync() {
  stopped = false;
  try {
    watch();
  } catch (err) {
    logger.warn(
      `[ProductSync] Could not start change stream — falling back to TTL refresh (${err.message})`,
    );
  }
}

export async function stopProductSync() {
  stopped = true;
  const cs = changeStream;
  changeStream = null;
  if (!cs) return;
  cs.removeAllListeners();
  try {
    await cs.close();
  } catch {
    // already closed
  }
}
