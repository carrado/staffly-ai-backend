import mongoose from "mongoose";

// A buyer's (or vendor's — see vendorId below) persisted search conversation
// + its active shopping task — Phase 1 of the frontend repo's
// docs/velte-ai-search-flow-plan.md. Owned by an anonymous per-browser
// deviceId (an unguessable UUID the frontend keeps in localStorage — it
// doubles as the ownership token, same trust model as the public pay-link
// ids), optionally stamped with a verified buyer's or vendor's id once one
// exists on the request.
//
// `turns` are complete exchange snapshots (the frontend's StoredSearchTurn
// shape — see src/types/search.ts over there): `snapshot` is stored as
// Mixed and returned verbatim for the frontend to re-render after a
// refresh; the few typed fields alongside it are the ones THIS service
// reads itself to rebuild the model-facing text history (ensureConversation),
// duplicated out of the snapshot so no controller ever has to reach into a
// Mixed blob for them.

const turnSchema = new mongoose.Schema(
  {
    query: { type: String, default: "" },
    reply: { type: String, default: "" },
    contextNote: { type: String, default: null },
    awaitingBuyerRequestReply: { type: Boolean, default: false },
    buyerRequestMatchQuery: { type: String, default: null },
    // Same pattern as the pair above, for the fresh-comparison short-circuit
    // (velte frontend, 2026-09-09) — see that repo's comparisonRule.ts.
    awaitingComparisonPurchaseReply: { type: Boolean, default: false },
    comparisonPickItem: { type: String, default: null },
    // The full alternative list from that same fresh comparison (velte
    // frontend, 2026-09-16) — not just the pick — so a LATER "the other
    // one", even after an intervening dead-end turn, can resolve to the
    // untried alternative. The route scans the whole request's history for
    // the most recent non-empty one (rememberedComparisonOptions).
    comparisonOptions: { type: [String], default: undefined },
    // The vendor-search offer pair (velte frontend, 2026-09-15) — the
    // opposite-shaped sibling of the buyer-request pair above: real product
    // results WERE shown, and the reply asked whether the buyer would rather
    // have a vendor make/provide it directly. Found live, the exact bug this
    // field group's header already warns about: kept client-only for a day,
    // and "Yes, look for a vendor" fell straight through to the ordinary
    // product pipeline on every persisted conversation — which dead-ended
    // again and RE-OFFERED the same vendor search, in a loop.
    awaitingVendorSearchOffer: { type: Boolean, default: false },
    vendorSearchMatchQuery: { type: String, default: null },
    // True when the reply came from the frontend's suggestBuyingGuidance
    // (2026-09-15) — the route scans the request's history for this to make
    // sure a second round of invented brand names never follows the first.
    isGuidanceReply: { type: Boolean, default: false },
    // Same pattern again, for the Shopping Plan short-circuit's own budget
    // ask (2026-09-10). This one was briefly kept CLIENT-ONLY, which looked
    // fine and wasn't: the route prefers SERVER history whenever it's at
    // least as complete as the client's resent copy, so a flag that lives
    // only on the client is silently dropped the moment persistence is
    // healthy — the budget answer then falls through to the ordinary search
    // pipeline and the buyer gets asked for their location instead of a
    // checklist. Anything the route ROUTES on has to be persisted here.
    awaitingShoppingPlanReply: { type: Boolean, default: false },
    // Structural "was location/budget already asked" markers (2026-09-09) —
    // see the frontend's types/search.ts (SearchHistoryTurn) for the
    // freeform-phrasing bug these replace a text-regex scan for. Derived by
    // appendTurn from the turn's own `snapshot.clarification` at write time,
    // duplicated out here for the same reason every other typed field above
    // is: buildHistory reads these without ever touching the Mixed blob.
    askedLocation: { type: Boolean, default: false },
    askedBudget: { type: Boolean, default: false },
    // Same pattern again, same reason (see this field group's own header
    // comment) — the Shopping List clarify gate's own "already asked"
    // marker (velte frontend, 2026-09-13, shoppingListClarifyGate.ts).
    // Found live: kept client-only at first, and broke on the very first
    // real conversation once persistence kicked in — the exact bug this
    // comment already warned about for awaitingShoppingPlanReply above.
    askedShoppingListDetails: { type: Boolean, default: false },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const taskSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["gathering", "presented", "dead_end", "handed_off"],
      default: "gathering",
    },
    query: { type: String, default: "" },
    storesQuery: { type: String, default: null },
    productCount: { type: Number, default: 0 },
    storeCount: { type: Number, default: 0 },
    // ── The "goal sheet" (2026-08-25) ────────────────────────────────────
    // What the buyer is actually trying to get done, so a follow-up like
    // "can you find something cheaper?" has a real number to beat instead
    // of the model re-reading its own last reply and inferring one.
    //
    // `itemTerm` is the SECOND of the two locks that keep this from
    // leaking (the first is the frontend's requestRelation classifier):
    // remembered constraints only ever apply when the sheet's own item
    // still matches what the buyer is asking about now, so a ₦700k PS5
    // ceiling can never silently narrow a later fridge search even if the
    // classifier misreads the boundary. A price stated in the current
    // message always outranks both.
    itemTerm: { type: String, default: null },
    maxBudgetNaira: { type: Number, default: null },
    attributes: { type: [String], default: [] },
    // Products already put in front of this buyer for this request — so
    // the comparison can avoid re-crowning something they've seen, and so
    // "cheaper" knows what it has to beat.
    shownProductIds: { type: [String], default: [] },
    cheapestSeenNaira: { type: Number, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// The buyer's resolved location for this conversation (Phase 5 of the
// frontend's docs/velte-ai-search-flow-plan.md). Conversation-level, NOT
// inside `task`: the task object is rederived from scratch on every
// appended turn (see deriveTask), while location is settled once per
// session and must survive that — and a refresh — so the buyer is never
// asked for it twice. `declined` records a deliberate "search without it"
// (coordinates stay null in that case), which is just as important to
// remember as a shared position. `placeName` is the reverse-geocoded label
// for display only; matching always uses the coordinates.
const buyerLocationSchema = new mongoose.Schema(
  {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    placeName: { type: String, default: null },
    declined: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const searchConversationSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    // The verified buyer this conversation belongs to, when one is known —
    // stamped opportunistically on ensure/append whenever the frontend's
    // request carried a buyer session. Stored as a plain string (the
    // frontend's session buyerId), not a ref this service would ever
    // populate.
    buyerId: { type: String, default: null, index: true },
    // The verified VENDOR this conversation belongs to (2026-09-17) — a
    // vendor browsing /chat with no linked buyer account (the common case;
    // see the frontend's "Linked identities" note) still deserves their own
    // searches saved and listed, exactly like a buyer's. Same trust model as
    // buyerId above: a plain string the frontend's own verified auth_token
    // session supplies, never trusted from an unauthenticated caller.
    // Mutually exclusive with buyerId in practice — the frontend resolves
    // buyer-over-vendor whenever both cookies exist (see its /api/search
    // route's own actorType comment) and only ever sends one of the two —
    // but nothing here enforces that; both are simply optional owner stamps.
    vendorId: { type: String, default: null, index: true },
    turns: { type: [turnSchema], default: [] },
    task: { type: taskSchema, default: null },
    // The last few status lines already shown to this buyer (most-recent-
    // last, capped) — persisted so the frontend's status-phrase repeat
    // avoidance (statusPhrases.js's pickAvoiding over there) survives a
    // refresh instead of resetting blank and resurfacing the exact same
    // line. Replaced wholesale on every appendTurn.
    recentStatuses: { type: [String], default: [] },

    // ── The session's ACTIVE TOOL (2026-09-10) ───────────────────────────
    // The composer clears its tool badge the moment a message is sent, so
    // only the FIRST message of a multi-turn flow ever arrives carrying
    // `activeTool` — every follow-up looks toolless. That has now produced
    // the same bug three separate times (the reach-out offer, the
    // comparison pick, the Shopping Plan budget answer), each patched with
    // its own bespoke `awaiting…Reply` flag on the turn.
    //
    // This is the general version of that patch, per explicit product
    // direction: the tool belongs to the CONVERSATION, not to one message.
    // Once established it stays in play, and it is dropped on exactly two
    // events — the buyer asking for something unrelated (the route's own
    // already-vetoed `startsFreshRequest` boundary decision, classifier plus
    // structural overrides), or a brand new chat (which is a brand new
    // document, so it starts null by construction).
    //
    // Deliberately NOT an enum: the tool list lives in the frontend
    // (composer + toolAlignment.ts), and mirroring it here would be a second
    // copy to keep in step for no gain — this service never interprets the
    // value, it only remembers it.
    activeTool: { type: String, default: null },

    buyerLocation: { type: buyerLocationSchema, default: null },
    lastActiveAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// The chat-history list's exact query (2026-08-26): every conversation for
// one buyer, newest first — see listConversations. The single-field buyerId
// index above can find the buyer's documents but leaves the sort to be done
// in memory over all of them, which is the wrong shape for the one query
// the sidebar runs on every page load. Compound, in sort order, so the
// index itself returns them already ordered.
searchConversationSchema.index({ buyerId: 1, lastActiveAt: -1 });
// Same shape, for a vendor's own history list (2026-09-17) — see vendorId
// above.
searchConversationSchema.index({ vendorId: 1, lastActiveAt: -1 });

export default mongoose.model("SearchConversation", searchConversationSchema);
