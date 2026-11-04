# staffly-ai-backend

Velte Connect's buyer-facing **AI search** service — split out of `velte-backend`
so the search hot path (public, unauthenticated, expected to be the highest-
traffic surface once Velte Connect ships) doesn't share deploys or request
volume with the vendor dashboard API.

Express 4, ES modules, Mongoose. `yarn dev` / `npm run dev` (nodemon) or
`npm start`; listens on `PORT`, default **7100**. No lint, build, or test step
— `npm run test:retrieval` runs `src/scripts/test-retrieval.js`, a manual
ranking harness, not a test suite.

## What lives here

**Public** (`/api/search/*`, no session — called by the velte frontend's BFF,
never directly by a buyer's browser):

- `POST /products` — buyer names a specific item.
- `POST /products/verify` — a direct existence/not-suspended check for
  products the caller already knows about. Narrower than the ranked search
  above on purpose: a capped top-N result list can't distinguish "fell out of
  this cycle's window" from "gone", and Shopping Plan's sweep needs the
  provable question answered instead.
- `POST /stores` — buyer describes a kind of business.
- `POST /log` — demand-signal logging (recruitment leads only, Google Places
  and Instagram; **not** a general query log — a turn with nothing to report
  writes nothing).
- `POST /log/instagram-reachout` — the stronger recruitment signal, fired when
  a buyer actually taps through to a lead's DMs. Bumps `buyerReachOuts` rather
  than `hitCount` so "shown" and "contacted" stay distinct.
- `GET /category-schemas` — read side of the clarifying-question attribute
  overrides.
- `POST /conversations/ensure`, `POST /conversations/claim`,
  `GET /conversations`, `GET|DELETE /conversations/:id`,
  `POST /conversations/:id/turns`, `POST /conversations/:id/handoff` —
  persisted search threads plus the active shopping task. Ownership is "this
  deviceId **or** this signed-in buyer", so an account's threads open on any
  browser it signs into; `deviceId` is still required on every call and is
  still the only owner an anonymous buyer ever has. The two literal paths must
  stay declared before `/conversations/:id` — Express matches in order and
  `claim` would otherwise be swallowed as an invalid ObjectId.

**Internal** (`/api/internal/*`, service-to-service, guarded by
`verifyInternalSecret` — an `x-internal-secret` header matched against
`INTERNAL_SERVICE_SECRET`; no buyer session applies and an unset secret 503s
every call rather than failing open):

- `POST /match-buyer-request` — ranks vendors for a Buyer Request. Called by
  `velte-backend`'s `services/matchingClient.service.js`, best-effort: it
  returns an empty match list on any failure so a matching hiccup can never
  block request creation.
- `PUT|DELETE /category-schemas` — operator-only writes behind the public read.
- `POST /cheaper-alternative` — **currently orphaned.** It was the price-watch
  market check, and price watches were deleted from both repos on 2026-09-06.
  Nothing calls it. Left in place rather than deleted, same restraint the dead
  env vars in the other repos got, but don't treat it as live.

`GET /health` is unauthenticated and outside the `/api` prefix.

## The retrieval core

`src/services/retrieval.service.js` (the big one, ~1.4k lines) implements
`Velte_Connect_Technical_Implementation.md` §6: Voyage embed → Atlas
`$vectorSearch` → rerank, scored as **semantic 0.5 + proximity 0.3 + trust
0.2**. `placementBoost` is deliberately absent — monetization isn't switched
on. With no location signal at all, proximity is dropped and the other two
renormalize proportionally (~0.714 : 0.286) rather than inventing a new ratio.

Around that: a geo tier cascade (local → nearby at 3× the tight radius →
state → nationwide → Google Places fallback), an additive attribute-match
nudge capped at 0.1 so stated qualities can break a tie but never seat a worse
match ahead of a better one, separate match floors for reranked vs. raw Atlas
scores (different distributions, both live-calibrated), wallet-eligibility
filtering, exposure-based result rotation, and expired-listing notifications.

Every Voyage call inside one `searchProducts`/`searchStores` invocation shares
a **22s deadline** (`SEARCH_DEADLINE_MS`). The frontend's own client timeout
sits above it at 30s on purpose — that one is a "something is genuinely stuck"
net, not a race against search still legitimately working.

## What deliberately stayed in `velte-backend`

- `POST /api/search/lead` (wallet debit when the buyer clicks through to
  WhatsApp) — the frontend's `sendBeacon` already hits `velte-backend`
  directly, so no cross-service call was ever needed. Keeping wallet mutation
  in one repo also avoids duplicating money-handling code that has already had
  two hard-won concurrency bugs fixed in it.
- All wallet **creation** (`getOrCreateWallet`, starter-credit grant) —
  `velte-backend` provisions a vendor's wallet proactively at store-creation
  time (`store.controller.js`'s `getOrCreateStore`) specifically so this
  service never needs to. `WalletRead` here is read-only **by convention** —
  never call `.save()`/`.create()` on it. A vendor with no wallet row is
  simply treated as `balanceKobo` 0 and filtered out, never auto-provisioned.
- Product/Store **writes**, including embedding generation on create/update —
  `velte-backend` kept a slim `embedding.service.js` (renamed from its old
  `retrieval.service.js`) for exactly that.

## Two repos, one database

Both services connect to the **same MongoDB cluster** with independent
Mongoose connections. The only service-to-service HTTP in either direction is
`velte-backend` → this repo's `/api/internal/*`; the search hot path makes no
cross-service call at all.

URI selection follows `velte-backend`'s rule exactly: `NODE_ENV=production` →
`MONGODB_URI_PRODUCTION`, everything else including staging → `MONGODB_URI`.
So localhost and staging share one DB and only live `velte.ng` has its own.

| Collection | Owner (writes) | Read by staffly-ai-backend? |
|---|---|---|
| `products`, `stores` | velte-backend | Yes (read-only models here) |
| `users` (vendor fields) | velte-backend | Yes (`VendorRead`, read-only subset) |
| `wallets` | velte-backend | Yes (`WalletRead`, read-only, never creates) |
| `vendorexposures` | **this repo** | — |
| `recruitmentleads` | **this repo** | — |
| `searchconversations` | **this repo** | — |
| `categoryschemas` | **this repo** | — |
| `notifications`, `pushsubscriptions` | shared — both write | both |

`categoryschemas` is an **overrides** layer, not a migration: the collection
starts empty and the frontend's in-code presets stay the complete fallback, so
a document here tunes a category's clarifying questions without a deploy and
deleting it reverts to the shipped defaults.

## Keeping things in sync

`Product.model.js`, `Store.model.js`, and `VendorRead.model.js` are hand-
duplicated from `velte-backend`'s schemas (a `strict:false`/lean subset for the
latter). There's no shared package yet — if a field used by ranking (`geo`,
`trustScore`, `embedding`, price, stock, etc.) is renamed or removed in
`velte-backend`, mirror the change here too. `voyage.service.js`,
`googlePlaces.service.js`, and `nominatim.service.js` are duplicated verbatim
(thin third-party API wrappers, not business logic — low drift risk).

`LEAD_COST_KOBO` must equal `velte-backend`'s `MIN_LEAD_COST_KOBO`
(`src/utils/leadPricing.js`) exactly, or the search-time wallet-eligibility
filter and actual per-lead billing disagree. **The rate is one flat ₦1,000 for
every vendor** (`LEAD_COST_KOBO=100000`) since 2026-09-03, when the three
balance tiers were deleted; `retrieval.service.js`'s own header still describes
the old ₦500–₦1,000 tiering and the reason this var mirrors only the top tier
— that reasoning is obsolete, though the resulting number is unchanged.

## Environment

See `.env.example`. Same cluster, same `VOYAGE_API_KEY` /
`GOOGLE_PLACES_API_KEY` / VAPID keypair as `velte-backend`.
`INTERNAL_SERVICE_SECRET` must match `velte-backend`'s copy of the same var —
note that repo also holds a *separate* secret for the frontend's Shopping Plan
internal route; a leak on one internal channel must not compromise the other.
`BASE_URL` only matters in production: `initializers/keepAlive.js` self-pings
`/health` every 10 minutes to stay ahead of the ~15-minute free-tier idle
cutoff, and skips entirely without a public `BASE_URL`.

Security middleware mirrors `velte-backend`: `helmet`, `hpp`,
`express-mongo-sanitize`, `trust proxy` set to exactly 1 (one reverse-proxy
hop; never `true`, which is spoofable), and the same hardcoded CORS allowlist
(`localhost:4001`, `velte-dev.vercel.app`, `velte.ng`). The rate limit is
**300 req / 15 min**, higher than `velte-backend`'s 100 because a public search
surface is the whole point of the split. `/api/search/conversations` gets its
own **300kb** JSON parser registered ahead of the global **10kb** one — a turn
snapshot carries the turn's full result arrays and routinely exceeds 10kb.

## Frontend wiring

Done. `velte`'s `src/lib/server/aiSearchBackend.ts` is a sibling of
`backend.ts` pointed at `AI_SEARCH_API_URL` (default
`http://localhost:7100/api`), exposing the same `aiSearchFetch`/`aiSearchData`
pair over the identical `{ success, data }` envelope. Only the search tools
(`searchProductsTool`, `searchStoresTool`), the recruitment-lead log calls, the
conversation BFF routes, and the attribute-schema read go through it;
everything else — auth, vendors, products, orders, wallet, and
`/api/search/lead` — still points at `velte-backend` unchanged.
