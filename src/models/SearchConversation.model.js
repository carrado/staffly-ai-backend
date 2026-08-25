import mongoose from "mongoose";

// A buyer's persisted search conversation + its active shopping task —
// Phase 1 of the frontend repo's docs/velte-ai-search-flow-plan.md. Owned
// by an anonymous per-browser deviceId (an unguessable UUID the frontend
// keeps in localStorage — it doubles as the ownership token, same trust
// model as the public pay-link ids), optionally stamped with a verified
// buyer's id once one exists on the request.
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
    turns: { type: [turnSchema], default: [] },
    task: { type: taskSchema, default: null },
    // The last few status lines already shown to this buyer (most-recent-
    // last, capped) — persisted so the frontend's status-phrase repeat
    // avoidance (statusPhrases.js's pickAvoiding over there) survives a
    // refresh instead of resetting blank and resurfacing the exact same
    // line. Replaced wholesale on every appendTurn.
    recentStatuses: { type: [String], default: [] },
    buyerLocation: { type: buyerLocationSchema, default: null },
    lastActiveAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

export default mongoose.model("SearchConversation", searchConversationSchema);
