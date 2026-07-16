# staffly-ai-backend

Velte Connect's buyer-facing **AI search** service — split out of `velte-backend`
so the search hot path (public, unauthenticated, expected to be the highest-
traffic surface once Velte Connect ships) doesn't share deploys or request
volume with the vendor dashboard API.

## What lives here

- `POST /api/search/products` — buyer names a specific item.
- `POST /api/search/stores` — buyer describes a kind of business.
- `POST /api/search/log` — demand-signal logging (Google Places recruitment
  leads only; not a general query log).
- The full retrieval/ranking core (`src/services/retrieval.service.js`):
  Voyage embed + Atlas `$vectorSearch` + rerank, geo tiering (local → nearby
  → state → nationwide → Google Places fallback), wallet-eligibility
  filtering, exposure-based result rotation, expired-listing notifications.

## What deliberately stayed in `velte-backend`

- `POST /api/search/lead` (wallet debit on "Chat on WhatsApp" click) — the
  frontend's `sendBeacon` call already hits `velte-backend` directly for
  this, so no cross-service call was ever needed. Keeping wallet mutation
  logic in one repo also avoids duplicating money-handling code that's
  already had two hard-won concurrency bugs fixed in it.
- All wallet **creation** (`getOrCreateWallet`, starter-credit grant) —
  `velte-backend` now provisions a vendor's wallet proactively at
  store-creation time (`store.controller.js`'s `getOrCreateStore`) instead
  of lazily during search, specifically so this service never needs to
  create one. This service's `WalletRead` model is read-only by convention —
  never call `.save()`/`.create()` on it.
- Product/Store **writes**, including embedding generation on create/update
  — `velte-backend` kept a slim `embedding.service.js` (renamed from its old
  `retrieval.service.js`) for exactly that.

## Two repos, one database

Both services connect to the **same MongoDB cluster** with independent
Mongoose connections — no API calls between them for the search hot path.
Collections split as:

| Collection | Owner (writes) | Read by staffly-ai-backend? |
|---|---|---|
| `products`, `stores` | velte-backend | Yes (read-only models here) |
| `users` (vendor fields) | velte-backend | Yes (`VendorRead`, read-only subset) |
| `wallets` | velte-backend | Yes (`WalletRead`, read-only, never creates) |
| `vendorexposures` | **this repo** | — |
| `recruitmentleads` | **this repo** | — |
| `notifications`, `pushsubscriptions` | shared — both write | both |

## Keeping schemas in sync

`Product.model.js`, `Store.model.js`, and `VendorRead.model.js` are hand-
duplicated from `velte-backend`'s schemas (a `strict:false`/lean subset for
the latter). There's no shared package yet — if a field used by ranking
(`geo`, `trustScore`, `embedding`, price, stock, etc.) is renamed or removed
in `velte-backend`, mirror the change here too. `voyage.service.js`,
`googlePlaces.service.js`, and `nominatim.service.js` are also duplicated
verbatim (thin third-party API wrappers, not business logic — low drift
risk).

`LEAD_COST_KOBO` (env var here, source-of-truth constant in
`velte-backend/src/controllers/wallet/wallet.controller.js`) must be kept
equal in both places — a mismatch means the search-time wallet-eligibility
filter and the actual per-lead billing amount disagree.

## Environment

See `.env.example`. Same MongoDB cluster, same `VOYAGE_API_KEY`/
`GOOGLE_PLACES_API_KEY`/VAPID keypair as `velte-backend`.

## Frontend wiring (not yet done)

The Next.js app's BFF needs a second base URL alongside `BACKEND_API_URL`
(e.g. `AI_SEARCH_API_URL`) so its search-related API routes point here
instead of `velte-backend`. Everything else (auth, vendors, products,
orders, wallet, `/api/search/lead`) keeps pointing at `velte-backend`
unchanged.
