/**
 * Webhook Controller
 *
 * Handles incoming WhatsApp text, voice notes, and audio messages.
 * Routes each message by phone_number_id to the correct business.
 * Supports:
 * - product search
 * - search pagination / show more
 * - voice note transcription
 * - attribute checks
 * - negotiation
 * - payment link generation
 */

import {
  getBusinessByPhoneNumberId,
  getBusinessById,
} from "../models/Business.js";
import {
  getSession,
  setSession,
  setLastProduct,
  setNegotiation,
  clearNegotiation,
  hydrateSession,
  clearPendingFollowUp,
} from "../models/ConversationState.js";
import * as whatsapp from "../services/whatsapp.service.js";
import * as openaiService from "../services/openai.service.js";
import * as productService from "../services/product.service.js";
import * as paymentService from "../services/payment.service.js";
import {
  startNegotiation,
  evaluateOffer,
  concede,
} from "../services/negotiation.service.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const SEARCH_PAGE_SIZE = 3; // image cards per page for a specific search
const SEARCH_MAX_CARD_PAGES = 2; // card pages in chat before handing off to the online store
const STORE_URL_BASE = "https://velte.ng/stores";
const SEARCH_LIMIT = 50;
const BROWSE_PAGE_SIZE = 10; // numbered text entries per page for a broad "*" browse
const BROWSE_LIMIT = 200; // broad browse pages through the whole catalog
const SIMILAR_PAGE_SIZE = 4; // text-only "similar negotiable" alternatives
const LOW_STOCK_THRESHOLD = 5; // used to justify counter-offers ("only N left")
const STRONG_MATCH_PERCENT = 90; // matchPercent at/above this = what the customer asked for

// Actions that can carry buyer/checkout details (see extractCheckoutData) and so
// a unit quantity we may need to recover when the model omits it on this turn.
const CHECKOUT_ACTIONS = new Set([
  "generate_payment_link",
  "accept_offer",
  "make_offer",
]);
// Browse/search turns where a number means "how many results", not order qty —
// never let one of those overwrite the remembered checkout quantity.
const QUANTITY_PERSIST_BLOCKED = new Set([
  "search_products",
  "show_more_products",
  "list_categories",
  "send_product_image",
  "find_similar_negotiable",
  "check_attribute",
]);

// Fixed, code-composed strings the customer can see. AI-written replies mirror
// the customer's language on their own; these cover everything written in code.
// The session's `language` is detected each turn by the action-decision model.
const STRINGS = {
  english: {
    moreItems: (n) =>
      `I still have ${n} more item${n === 1 ? "" : "s"} — reply *show more* to see ${n === 1 ? "it" : "them"}.`,
    otherItems: (n) =>
      `I also have ${n} other item${n === 1 ? "" : "s"} that ${n === 1 ? "isn't" : "aren't"} exactly what you asked for but could still be a good fit — reply *show more* to see ${n === 1 ? "it" : "them"}.`,
    productGone:
      "Sorry, that product is no longer available. Tell me what you're looking for and I'll find something similar.",
    pickedFood: (name, mins) =>
      `Great choice! 😊 Would you like to order *${name}* now${mins ? ` — it'll be ready in ~${mins} mins` : ""}?`,
    pickedRetail: (name) =>
      `Great choice! 😊 Would you like to buy *${name}*, check a size or color, or negotiate the price?`,
    negCounter: (name, price) =>
      `For *${name}*, the best I can do right now is ₦${price}. Want me to package it for you at that price?`,
    // A SECOND (or later) reduction — never repeat the round-1 line. Frame it as a
    // fresh cut made specially for the customer, justified by the product's quality.
    negCounterAgain: (name, price, round) =>
      round >= 3
        ? `Tell you what — *${name}* is one of my best pieces and built to last, but I'll shave off a little more just for you: ₦${price}. Shall I package it?`
        : `Okay, let me come down a bit more for you — *${name}* is genuinely good quality, so I'll do ₦${price}. Want me to package it?`,
    negFinal: (name, price) =>
      `I've come down as far as I can on *${name}* — ₦${price} is honestly the lowest I can let it go for. Shall I package it for you?`,
    notUnderstood:
      "Sorry, I could not understand that message. Please send text or a clear voice note.",
    somethingWrong:
      "Sorry, something went wrong on my end. Please try that again in a moment 🙏",
  },
  pidgin: {
    moreItems: (n) =>
      `I still get ${n} more item${n === 1 ? "" : "s"} — reply *show more* make you see ${n === 1 ? "am" : "them"}.`,
    otherItems: (n) =>
      `I get ${n} other item${n === 1 ? "" : "s"} wey no be exactly wetin you ask for, but e fit still work for you — reply *show more* make you see ${n === 1 ? "am" : "them"}.`,
    productGone:
      "Sorry o, that product don finish. Tell me wetin you dey find make I show you something wey resemble am.",
    pickedFood: (name, mins) =>
      `Correct choice! 😊 You wan order *${name}* now${mins ? ` — e go ready in ~${mins} mins` : ""}?`,
    pickedRetail: (name) =>
      `Correct choice! 😊 You wan buy *${name}*, check size or color, or you wan price am small?`,
    negCounter: (name, price) =>
      `For *${name}*, the best wey I fit do now na ₦${price}. Make I package am for you for that price?`,
    // A SECOND (or later) reduction — no need to repeat the round-1 line. Frame it
    // as a fresh cut made because of the customer, backed by the product quality.
    negCounterAgain: (name, price, round) =>
      round >= 3
        ? `Make I tell you — *${name}* na one of my best goods wey strong well well, but I go cut am small more just for you: ₦${price}. Make I package am?`
        : `Okay, make I reduce am small more for you — *${name}* quality good well well, so I go do ₦${price}. Make I package am?`,
    negFinal: (name, price) =>
      `I don try reach my limit for *${name}* — ₦${price} na the last price wey I fit sell am give you. Make I package am?`,
    notUnderstood:
      "Sorry, I no understand that message. Abeg send text or clear voice note.",
    somethingWrong:
      "Sorry, something spoil for my side. Abeg try am again small time 🙏",
  },
};

const t = (language) => STRINGS[language] || STRINGS.english;

// Async accessor for code-composed strings. English and Pidgin use the
// hand-written tables above; any other language gets an AI-translated, cached
// version (see openai.service translateUiString). `pick` renders the wanted
// string from a table, e.g. tr(language, (s) => s.moreItems(3)).
async function tr(language, pick) {
  const table = STRINGS[language];
  if (table) return pick(table);
  return openaiService.translateUiString(pick(STRINGS.english), language);
}

// A negotiation counter/final price is money-critical and ALREADY decided by the
// engine. The reply model (gpt-4o-mini) has been observed to ignore the engine's
// number and refuse the customer ("it's priced at ₦X, I can't go down to ₦Y"),
// restating the list price — so we compose these two outcomes deterministically
// and never let the model pick the figure (same stance as enforcePaymentLink).
// Returns the ready-to-send reply, or null to defer to the model (accept/needsInfo
// outcomes carry a checkout summary + payment link, so those still go through it).
async function composeNegotiationReply(language, neg) {
  if (!neg) return null;
  if (neg.outcome === "counter" && Number.isFinite(neg.counterPrice)) {
    const price = neg.counterPrice.toLocaleString();
    // Round 1 is the opening counter ("best I can do right now"); every later
    // reduction uses a distinct, quality-justified phrasing so we never repeat it.
    const round = Number(neg.round) || 1;
    if (round >= 2) {
      return tr(language, (s) => s.negCounterAgain(neg.product, price, round));
    }
    return tr(language, (s) => s.negCounter(neg.product, price));
  }
  if (neg.outcome === "final" && Number.isFinite(neg.finalPrice)) {
    return tr(language, (s) =>
      s.negFinal(neg.product, neg.finalPrice.toLocaleString()),
    );
  }
  return null;
}

// Internal grounding markers we write into the conversation history — e.g.
// "[Sent product cards: ...]" — must NEVER reach the customer. The classifier
// and the response model both replay history verbatim, and they sometimes parrot
// the marker back into their reply (often truncated, like "[Sent product cards:").
// Strip any such fragment — closed or not — from every customer-facing message.
function stripInternalMarkers(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\[Sent product cards\b[^\]]*\]?/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The payment URL is money-critical and must reach the customer byte-for-byte.
// The reply model is NOT trusted to render it: it tends to "fix" URLs it deems
// odd (e.g. rewriting a localhost velte link to some other domain) or hallucinate
// one. So the model only leaves a {{PAYMENT_LINK}} placeholder; here we swap in
// the real link, overwrite any URL it invented anyway, and guarantee it's present.
function enforcePaymentLink(text, link) {
  if (!link) return text;
  let out = String(text ?? "").replace(/\{\{\s*PAYMENT_LINK\s*\}\}/gi, link);
  // Replace any other URL the model emitted (a rewrite/hallucination) with ours.
  const urls = out.match(/\bhttps?:\/\/\S+/gi) || [];
  for (const u of urls) {
    if (u !== link) out = out.split(u).join(link);
  }
  if (!out.includes(link)) out = `${out.trim()}\n\n${link}`;
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// AI-written, code-guarded "N more items — *show more*" line. The count and the
// decision to show it at all come from code (grounding); the model only phrases
// it. The result is accepted ONLY if it contains the exact count AND a "show
// more" cue — otherwise (or on failure) we fall back to the fixed template, so
// the offer can never carry a wrong count or be dropped.
async function composeMoreItemsHint({
  count,
  asSuggestions,
  language,
  business,
}) {
  const template = await tr(language, (s) =>
    asSuggestions ? s.otherItems(count) : s.moreItems(count),
  );

  try {
    const note = await openaiService.generateMoreItemsNote({
      count,
      asSuggestions,
      language,
      business,
    });
    if (note && note.includes(String(count)) && /show more/i.test(note)) {
      return note;
    }
  } catch {
    // fall through to the guaranteed-correct template
  }

  return template;
}

function buildConversationHistory(
  currentHistory = [],
  userMessage,
  assistantMessage,
) {
  return [
    ...currentHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantMessage },
  ];
}

function createDefaultActionResult(message) {
  return { error: message };
}

function getResolvedProductName(actionData = {}, session = {}) {
  return actionData.productName || session.lastProduct?.name || null;
}

function mapProductForAI(product) {
  // 999 is the "untracked stock" sentinel — report it as unknown (in stock)
  // so the AI never quotes it as a literal count.
  const stock =
    typeof product.stock === "number" && product.stock !== 999
      ? product.stock
      : null;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    price: product.price,
    description: product.description,
    tags: product.tags || [],
    useCases: product.useCases || [],
    attributes: product.attributes || {},
    allow_negotiation: product.allow_negotiation,
    stock,
    inStock: stock === null ? true : stock > 0,
    lowStock: stock !== null && stock > 0 && stock <= LOW_STOCK_THRESHOLD,
    isFood: product.is_food || false,
    prepTimeMins: product.prep_time_mins ?? null,
    soldOutForToday: product.sold_out_for_today || false,
    allowPreOrder: product.allow_preorder || false,
    modifiers: product.modifiers || [],
  };
}

/**
 * Match the customer's chosen modifier option names against the product's
 * modifier groups. Server-side source of truth: the AI only relays names; the
 * groups, prices, and required rules come from the product itself.
 */
function resolveSelectedModifiers(product, selectedNames = []) {
  const picked = (selectedNames || []).map((n) =>
    String(n).toLowerCase().trim(),
  );
  const selections = [];
  const missingRequired = [];

  for (const group of product.modifiers || []) {
    const matched = group.options.filter((o) =>
      picked.includes(o.name.toLowerCase()),
    );
    const chosen = group.multiSelect ? matched : matched.slice(0, 1);

    if (group.required && chosen.length === 0) {
      missingRequired.push(group);
      continue;
    }

    selections.push(
      ...chosen.map((o) => ({
        group: group.name,
        name: o.name,
        additionalPrice: o.additionalPrice || 0,
      })),
    );
  }

  const extraTotal = selections.reduce((sum, s) => sum + s.additionalPrice, 0);
  return { selections, missingRequired, extraTotal };
}

// Modifier/add-on names the customer asked for that the product does NOT offer in
// ANY group — e.g. "extra plantain" on a dish without that add-on. These are
// otherwise silently dropped by resolveSelectedModifiers, so we surface them to
// flag back to the customer instead of quietly ignoring the request (it matters
// most at the payment step, where the order would otherwise complete without the
// item they asked for). Only judged for products that actually HAVE modifier
// groups — with none, there's nothing to validate against and the classifier may
// have mis-tagged an ordinary word as a modifier.
function unavailableModifierRequests(product, names = []) {
  const offered = new Set();
  for (const group of product.modifiers || []) {
    for (const o of group.options || [])
      offered.add(String(o.name).toLowerCase());
  }
  if (offered.size === 0) return [];

  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (!offered.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(t); // preserve the customer's original casing for the reply
    }
  }
  return out;
}

// A perfect order needs more than the product: a chosen size/colour when the
// product lists them, every required food modifier, and the buyer's name, email
// and delivery location. The next three helpers gather those across turns, work
// out what's still missing, and only place the order once nothing is.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Buyer-detail sanitisers. The checkout gate trusts these fields as proof the
// customer supplied them, so a value the model GUESSED or copied from the
// instruction examples (rather than read from the customer) must be rejected —
// otherwise the order proceeds on phantom data. Each returns null for an absent
// or placeholder value, which keeps the gate asking. RFC 2606 reserves
// example/test domains, so any email there is never a real customer address.
const PLACEHOLDER_EMAIL_DOMAINS =
  /@(?:example|test|sample|email|domain|mail|acme)\.(?:com|org|net)$/i;
const PLACEHOLDER_NAMES = new Set([
  "john doe",
  "jane doe",
  "john smith",
  "jane smith",
  "full name",
  "your name",
  "customer name",
  "name",
  "first last",
]);

function cleanCheckoutName(value) {
  const t = (value ?? "").toString().trim();
  if (t.length < 2) return null;
  if (PLACEHOLDER_NAMES.has(t.toLowerCase())) return null;
  return t;
}
function cleanCheckoutEmail(value) {
  const t = (value ?? "").toString().trim();
  if (!EMAIL_RE.test(t)) return null;
  if (PLACEHOLDER_EMAIL_DOMAINS.test(t)) return null;
  return t;
}
function cleanCheckoutLocation(value) {
  const t = (value ?? "").toString().trim();
  if (t.length < 3) return null;
  return t;
}

// Detect buyer-detail values the customer ACTUALLY supplied this turn that failed
// validation — a malformed email, a one-letter "name", a too-short address. We
// only flag a field that's still unfilled (no valid value carried from a prior
// turn), so the reply can tell the customer their entry didn't look right and ask
// again, instead of silently re-asking the same question. Returns the raw bad
// value per field (so the reply can quote it back), keyed by the gap field name.
function rejectedCheckoutInputs(prior = {}, data = {}) {
  const raw = (v) => (v ?? "").toString().trim();
  const rejected = {};
  if (raw(data.email) && !cleanCheckoutEmail(data.email) && !prior.email) {
    rejected.email = raw(data.email);
  }
  if (
    raw(data.customerName) &&
    !cleanCheckoutName(data.customerName) &&
    !prior.customerName
  ) {
    rejected.name = raw(data.customerName);
  }
  if (
    raw(data.location) &&
    !cleanCheckoutLocation(data.location) &&
    !prior.location
  ) {
    rejected.location = raw(data.location);
  }
  return rejected;
}

// Resolve a customer-typed value to the product's canonical option (case-
// insensitive). Returns null when the value isn't one of the real options, so a
// typo or a not-offered choice is treated as "still needs a valid pick".
function resolveOption(value, options = []) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  return options.find((o) => String(o).toLowerCase().trim() === v) || null;
}

// A blank variant line in canonical form: variant choices as a case-preserving
// { attrName: value } map, modifier names, and a unit count.
function defaultLine() {
  return {
    selectedSize: null,
    selectedColor: null,
    selectedAttributes: {},
    selectedModifiers: [],
    quantity: null,
  };
}

// Normalise one extracted item ({ quantity, selectedSize, selectedColor,
// selectedAttributes:[{name,value}], selectedModifiers:[] }) into a canonical line.
function toLine(item = {}) {
  const attrMap = {};
  if (Array.isArray(item.selectedAttributes)) {
    for (const a of item.selectedAttributes) {
      if (a && a.name && a.value) attrMap[a.name] = a.value;
    }
  }
  return {
    selectedSize: item.selectedSize || null,
    selectedColor: item.selectedColor || null,
    selectedAttributes: attrMap,
    selectedModifiers: Array.isArray(item.selectedModifiers)
      ? item.selectedModifiers.filter(Boolean)
      : [],
    quantity: normalizeQuantity(item.quantity) ?? null,
  };
}

// Accumulate one line's choices across turns (new picks win, earlier ones kept)
// so a buyer answering one question at a time still completes that line.
function mergeLine(prev = {}, next = {}) {
  return {
    selectedSize: next.selectedSize || prev.selectedSize || null,
    selectedColor: next.selectedColor || prev.selectedColor || null,
    selectedAttributes: {
      ...(prev.selectedAttributes || {}),
      ...(next.selectedAttributes || {}),
    },
    selectedModifiers:
      next.selectedModifiers && next.selectedModifiers.length
        ? next.selectedModifiers
        : prev.selectedModifiers || [],
    quantity: next.quantity ?? prev.quantity ?? null,
  };
}

// Merge the details supplied this turn with everything gathered on earlier turns
// so checkout info accumulates instead of resetting when the customer answers one
// question at a time. Buyer details are shared; the variant/quantity breakdown is
// a list of lines (one per distinct variant). A turn that restates the breakdown
// replaces it; a turn that supplies only buyer details keeps the prior lines. When
// the line count is unchanged, lines merge by position so a single line's choices
// still accumulate across turns. New non-null values win; prior values are kept.
function mergeCheckout(prior = {}, data = {}, resolvedProductName = null) {
  const incoming = Array.isArray(data.items) ? data.items.map(toLine) : [];
  const priorLines = prior.lines || [];
  let lines;
  if (!incoming.length) {
    lines = priorLines;
  } else if (priorLines.length === incoming.length) {
    lines = incoming.map((ln, i) => mergeLine(priorLines[i], ln));
  } else {
    lines = incoming;
  }
  return {
    productName: resolvedProductName || prior.productName || null,
    // Sanitise THIS turn's values (prior values were already cleaned when
    // stored), so a guessed/placeholder name, email or address never counts as
    // "provided" and the gate keeps asking for the real one.
    email: cleanCheckoutEmail(data.email) || prior.email || null,
    customerName:
      cleanCheckoutName(data.customerName) || prior.customerName || null,
    location: cleanCheckoutLocation(data.location) || prior.location || null,
    lines,
    // A single count stated on an earlier turn (recovered by the quantity safety
    // net), used as the default for a one-line order that never got an explicit
    // per-line quantity. Carried across turns; ignored for multi-line orders.
    pendingQuantity:
      normalizeQuantity(data.pendingQuantity) ?? prior.pendingQuantity ?? null,
    // A price agreed via negotiation overrides the list price; carried across
    // turns so a checkout completed later still closes at the agreed number.
    negotiatedPrice: prior.negotiatedPrice ?? null,
  };
}

// A whole-number unit quantity (≥1), or null when not a usable number.
function normalizeQuantity(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// Flatten an attribute's stored values into the distinct options a buyer can
// choose from. Velte may store a variant as several rows (["S","M","L"]) or as
// one comma/slash-joined row (["S, M, L"]) — both collapse to ["S","M","L"].
// Case-insensitive dedupe, first-seen casing kept.
function normalizeAttrOptions(rawValues = []) {
  const out = [];
  const seen = new Set();
  for (const v of rawValues) {
    for (const part of String(v).split(/[,/]/)) {
      const t = part.trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(t);
      }
    }
  }
  return out;
}

// The value the customer chose for a given attribute, looked up across the
// generic selectedAttributes map (case-insensitive on the attribute name) and
// the legacy selectedSize/selectedColor fields, so existing model output still
// resolves for size/colour attributes.
function pickSelectedAttr(checkout, attrName) {
  const sel = checkout.selectedAttributes || {};
  const key = Object.keys(sel).find(
    (k) => k.toLowerCase() === String(attrName).toLowerCase(),
  );
  if (key && sel[key]) return sel[key];
  const lname = String(attrName).toLowerCase();
  if (/size/.test(lname) && checkout.selectedSize) return checkout.selectedSize;
  if (/colou?r/.test(lname) && checkout.selectedColor)
    return checkout.selectedColor;
  return null;
}

// Everything still required before this product can become an order. Validates
// EACH variant line (every line needs a value for every multi-option attribute
// and every required modifier group), then the shared buyer details. `missing` is
// empty when the checkout is complete; otherwise each entry names a field the
// reply must ask for (attributes/modifiers carry their valid options). A per-line
// variant gap is tagged with a `line` descriptor — only when the order has more
// than one line — so the reply can ask about the right item. Asks are PHASED so
// the buyer isn't handed a long form: product variant choices first (they also
// settle the price), then name + email together, then delivery location.
// Accumulation across turns means a buyer who volunteers everything at once still
// completes — phasing only governs what we ASK when something's left.
function computeCheckoutGaps(product, checkout) {
  const lines =
    checkout.lines && checkout.lines.length ? checkout.lines : [defaultLine()];
  const attrGroups = product.attributes || {};
  const variantMissing = [];
  const resolvedLines = [];

  lines.forEach((line, index) => {
    const resolvedAttributes = {};
    const lineMissing = [];

    // Generic product attributes: any attribute the product lists with 2+ distinct
    // options is a real variant the buyer must pick (a single-value attribute is
    // just a spec — nothing to choose). Works for Size, Colour, Storage, Material,
    // Flavour, etc. with no per-attribute code.
    for (const [name, rawValues] of Object.entries(attrGroups)) {
      const options = normalizeAttrOptions(rawValues);
      if (options.length < 2) continue; // informational spec, not a choice
      const provided = pickSelectedAttr(line, name);
      const chosen = resolveOption(provided, options);
      if (chosen) {
        resolvedAttributes[name] = chosen;
      } else {
        // `invalidValue` is added ONLY when the customer actually picked something
        // for this attribute that isn't a real option (a typo or a not-offered
        // choice) — so the reply can point that out instead of asking from scratch.
        // Omitted entirely when they simply haven't chosen yet.
        const entry = { field: "attribute", name, options };
        if (provided) entry.invalidValue = provided;
        lineMissing.push(entry);
      }
    }

    // Required food modifier groups, per line.
    const modifierCheck = resolveSelectedModifiers(
      product,
      line.selectedModifiers,
    );
    if (modifierCheck.missingRequired.length > 0) {
      lineMissing.push({
        field: "modifiers",
        groups: modifierCheck.missingRequired.map((group) => ({
          name: group.name,
          multiSelect: group.multiSelect,
          options: group.options.map((o) => ({
            name: o.name,
            additionalPrice: o.additionalPrice,
          })),
        })),
      });
    }

    // Tag each gap with the line it belongs to, so a multi-line order can ask for
    // the right item ("for the 1 in black, which size?"). Single-line orders need
    // no tag — there's only one item to ask about.
    for (const m of lineMissing) {
      if (lines.length > 1) {
        m.line = {
          index,
          quantity: normalizeQuantity(line.quantity) ?? 1,
          chosen: resolvedAttributes,
        };
      }
      variantMissing.push(m);
    }

    resolvedLines.push({
      selectedSize: line.selectedSize,
      selectedColor: line.selectedColor,
      selectedAttributes: line.selectedAttributes,
      quantity: line.quantity,
      resolvedAttributes,
      selections: modifierCheck.selections,
      extraTotal: modifierCheck.extraTotal,
    });
  });

  const needName = !checkout.customerName;
  const needEmail = !checkout.email || !EMAIL_RE.test(checkout.email);
  const needLocation = !checkout.location;

  let missing;
  if (variantMissing.length > 0) {
    missing = variantMissing;
  } else if (needName || needEmail) {
    missing = [];
    if (needName) missing.push({ field: "name" });
    if (needEmail) missing.push({ field: "email" });
  } else if (needLocation) {
    missing = [{ field: "location" }];
  } else {
    missing = [];
  }

  return { missing, lines: resolvedLines };
}

// The price a buy should close at when the customer has been haggling. Prefer a
// price already locked into the in-progress checkout, then the standing number
// from an active negotiation for THIS product (our last counter, then their
// offer), clamped to [floor, list]. Returns null when nothing was negotiated, so
// the list price applies. Lets a "send me the link" / "I'll take it" that the
// model routes to generate_payment_link still honour the agreed price instead of
// reverting to the list price.
function resolveAgreedPrice(session, product) {
  const checkout = session.checkout;
  if (
    checkout?.negotiatedPrice != null &&
    checkout.productName === product.name
  ) {
    return checkout.negotiatedPrice;
  }
  const negotiation = session.negotiation;
  if (negotiation && negotiation.productId === product.id) {
    const agreed = negotiation.lastCounter ?? negotiation.currentOffer ?? null;
    if (agreed != null) {
      const floor = negotiation.minPrice ?? 0;
      return Math.min(Math.max(agreed, floor), product.price);
    }
  }
  return null;
}

// The human variant text for one resolved line, e.g. "Red, L" or "Chicken, Extra
// Plantain" — chosen attribute values first, then modifier add-on names. Empty
// string when the line has no variant/modifier choices.
function lineVariantText(item) {
  return [
    ...Object.values(item.attributes || {}),
    ...(item.modifiers || []).map((m) => m.name),
  ].join(", ");
}

// The order's display label on the link/invoice. A single line keeps the familiar
// "T-Shirt (L, Red) ×2" form; multiple lines list each variant with its count:
// "T-Shirt (Red ×3, Black ×1)".
function buildOrderLabel(product, items) {
  if (items.length <= 1) {
    const it = items[0];
    const variant = it ? lineVariantText(it) : "";
    const base = variant ? `${product.name} (${variant})` : product.name;
    return it && it.quantity > 1 ? `${base} ×${it.quantity}` : base;
  }
  const parts = items.map((it) => {
    const variant = lineVariantText(it);
    return variant ? `${variant} ×${it.quantity}` : `×${it.quantity}`;
  });
  return `${product.name} (${parts.join(", ")})`;
}

/**
 * The single gate every checkout passes through. Accumulates the buyer details,
 * and EITHER returns a `needsInfo` result (so the reply asks for exactly what's
 * left, and the gathered details persist to the session for the next turn) OR,
 * when nothing is missing, places the order via runCheckout and clears the
 * gathered state. `negotiatedPrice` (when set) is the agreed unit price that
 * overrides the list price. The order is one product with one or more variant
 * lines; the amount sums each line's (unit price + its modifier add-ons) × count.
 */
async function gatherCheckoutOrAsk({
  businessId,
  customerNumber,
  product,
  data = {},
  negotiatedPrice = null,
}) {
  const prior = getSession(businessId, customerNumber).checkout || {};
  const checkout = mergeCheckout(prior, data, product.name);
  if (negotiatedPrice != null) checkout.negotiatedPrice = negotiatedPrice;

  // A one-line order with no explicit per-line count inherits a quantity stated on
  // an earlier turn (the safety net stashes it as pendingQuantity).
  if (checkout.lines.length <= 1 && checkout.pendingQuantity != null) {
    const ln = checkout.lines[0] || defaultLine();
    if (ln.quantity == null) ln.quantity = checkout.pendingQuantity;
    checkout.lines = [ln];
  }

  const gaps = computeCheckoutGaps(product, checkout);

  // Per-line pricing: one shared unit price (negotiated or list) plus THAT line's
  // modifier add-ons, times the line's quantity; the order total sums the lines.
  const baseUnit = checkout.negotiatedPrice ?? product.price;
  const items = gaps.lines.map((line) => {
    const quantity = normalizeQuantity(line.quantity) ?? 1;
    const unitPrice = baseUnit + line.extraTotal;
    return {
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
      attributes: line.resolvedAttributes,
      modifiers: line.selections,
    };
  });
  const amount = items.reduce((sum, it) => sum + it.lineTotal, 0);
  const totalQuantity = items.reduce((sum, it) => sum + it.quantity, 0);
  const negotiated = checkout.negotiatedPrice != null;

  // Tag the name/email/location gaps with anything the customer just typed that
  // failed validation, so the reply flags the bad entry rather than re-asking
  // blankly. (Attribute gaps already carry their own `invalidValue`.)
  const rejected = rejectedCheckoutInputs(prior, data);
  for (const m of gaps.missing) {
    if (m.field === "email" && rejected.email) m.invalidValue = rejected.email;
    if (m.field === "name" && rejected.name) m.invalidValue = rejected.name;
    if (m.field === "location" && rejected.location)
      m.invalidValue = rejected.location;
  }

  // Add-ons the customer asked for THIS turn that the product doesn't offer,
  // gathered across every line in the turn's breakdown. Surfaced on every checkout
  // result so the reply flags them rather than silently dropping the request.
  const turnModifiers = Array.isArray(data.items)
    ? data.items.flatMap((i) => i.selectedModifiers || [])
    : [];
  const unavailableModifiers = unavailableModifierRequests(
    product,
    turnModifiers,
  );

  // A compact, reply-facing view of the lines (variant text + count + line total).
  const resultItems = items.map((it) => ({
    variant: lineVariantText(it),
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    lineTotal: it.lineTotal,
  }));

  if (gaps.missing.length > 0) {
    // Keep this product in focus and remember what we've gathered so far.
    setLastProduct(businessId, customerNumber, product);
    const s = getSession(businessId, customerNumber);
    setSession(businessId, customerNumber, { ...s, checkout });
    return {
      needsInfo: true,
      product: product.name,
      price: amount,
      quantity: totalQuantity,
      items: resultItems,
      multiLine: resultItems.length > 1,
      negotiated,
      missing: gaps.missing,
      collected: {
        // What's already been gathered, so the reply doesn't re-ask for it. For a
        // single line this is its chosen attributes; multi-line asks carry their
        // own per-line `chosen`, so the shared map is left empty.
        attributes:
          resultItems.length === 1 ? gaps.lines[0].resolvedAttributes : {},
        name: checkout.customerName || null,
        email: checkout.email || null,
        location: checkout.location || null,
      },
      ...(unavailableModifiers.length ? { unavailableModifiers } : {}),
    };
  }

  const result = await runCheckout({
    businessId,
    customerNumber,
    product,
    amount,
    quantity: totalQuantity,
    items,
    email: checkout.email,
    customerName: checkout.customerName,
    location: checkout.location,
  });

  // Order placed — clear the gathered checkout (and any finished negotiation) so
  // the next purchase starts clean.
  clearNegotiation(businessId, customerNumber);
  const s = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, { ...s, checkout: null });
  // At the payment step, flag against EVERYTHING gathered (every line, not just
  // this turn), so an add-on the customer requested on an earlier turn — while we
  // were still collecting their details — is still surfaced on the final summary
  // instead of being charged silently for less.
  const allModifiers = checkout.lines.flatMap((l) => l.selectedModifiers || []);
  const unavailableAtCheckout = unavailableModifierRequests(
    product,
    allModifiers,
  );
  return {
    ...result,
    negotiated,
    ...(unavailableAtCheckout.length
      ? { unavailableModifiers: unavailableAtCheckout }
      : {}),
  };
}

/**
 * Checkout handoff. Single source of truth for turning an agreed price into a
 * payment link + invoice. Both the buy flow and an accepted negotiation call
 * into this so the logic isn't duplicated.
 */
async function runCheckout({
  businessId,
  customerNumber,
  product,
  amount,
  quantity = 1,
  items = [],
  email,
  customerName,
  location,
}) {
  setLastProduct(businessId, customerNumber, product);

  // Fall back to a single, variant-less line so a plain order still has one item.
  const lines = items.length
    ? items
    : [
        {
          quantity,
          unitPrice: amount,
          lineTotal: amount,
          attributes: {},
          modifiers: [],
        },
      ];

  // E.g. "T-Shirt (L, Red) ×2" for a single line, or "T-Shirt (Red ×3, Black ×1)"
  // for a multi-variant order, on the payment link / invoice.
  const itemLabel = buildOrderLabel(product, lines);

  // The per-line breakdown carried to velte: stored on the order, flows into the
  // Paystack metadata and the fulfilment order. Each line is self-describing.
  const orderItems = lines.map((it) => {
    const variant = lineVariantText(it);
    return {
      name: variant ? `${product.name} (${variant})` : product.name,
      variant: variant || null,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
      attributes: Object.entries(it.attributes || {}).map(([name, value]) => ({
        name,
        value,
      })),
      modifiers: (it.modifiers || []).map((m) => ({
        group: m.group,
        name: m.name,
        additionalPrice: m.additionalPrice,
      })),
    };
  });

  // Derive size/colour from the first line's chosen attributes for the reply
  // summary, which reads them back to the customer (single-line orders).
  const firstAttrs = lines[0]?.attributes || {};
  const findAttr = (re) => {
    const k = Object.keys(firstAttrs).find((n) => re.test(n.toLowerCase()));
    return k ? firstAttrs[k] : null;
  };

  // `amount` is already VAT-inclusive (tax is folded in at the product mapper),
  // so it's charged as-is — the customer only ever sees a single "Price".
  const { paymentLink, orderId } = await paymentService.generatePaymentLink(
    businessId,
    customerNumber,
    itemLabel,
    amount,
    {
      customerName,
      customerEmail: email,
      location,
      quantity,
      items: orderItems,
      productId: product?.id ? String(product.id) : null,
      productImage: product?.image_url || null,
    },
  );

  // Arm an abandoned-checkout follow-up. If the customer pays (payment webhook)
  // or sends any further message (handled at the top of handleIncomingMessage),
  // this is cleared; otherwise the sweeper nudges them ~1 hour from now.
  const sessionBeforeCheckout = getSession(businessId, customerNumber);
  setSession(businessId, customerNumber, {
    ...sessionBeforeCheckout,
    pendingFollowUp: {
      orderId,
      productName: product.name,
      amount,
      createdAt: new Date(),
      sentAt: null,
    },
  });

  // Note: the receipt is emailed by velte-backend after payment settles (it owns
  // the order + receipt PDF). Staffly does not send any email itself.

  return {
    paymentLink,
    orderId,
    product: product.name,
    quantity,
    // VAT-inclusive total (Σ line totals), shown to the customer as "Price".
    price: amount,
    multiLine: orderItems.length > 1,
    // The variant breakdown for the reply to read back on a multi-variant order.
    items: orderItems.map((it) => ({
      variant: it.variant,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
    })),
    customerName: customerName || null,
    location: location || null,
    email: email || null,
    selectedAttributes: Object.entries(firstAttrs).map(([name, value]) => ({
      name,
      value,
    })),
    selectedSize: findAttr(/size/) || null,
    selectedColor: findAttr(/colou?r/) || null,
    selectedModifiers: (lines[0]?.modifiers || []).map((m) => ({
      group: m.group,
      name: m.name,
      additionalPrice: m.additionalPrice,
    })),
  };
}

/**
 * Card captions print product.description verbatim — for non-English sessions,
 * translate it into the session language so the card matches the conversation.
 * The card's fixed labels and button title are handled by whatsapp.service's own
 * string table.
 */
async function localizeProductsForLanguage(products, language) {
  if (!products.length) return products;
  return openaiService.translateDescriptions(products, language);
}

async function sendOutboundMessage({
  phoneNumberId,
  accessToken,
  customerNumber,
  responseText,
  productsToShow = [],
  language = "english",
}) {
  const products = await localizeProductsForLanguage(productsToShow, language);

  if (products.length === 1) {
    await whatsapp.sendProductCard(
      phoneNumberId,
      accessToken,
      customerNumber,
      products[0],
      responseText,
      language,
    );
    return;
  }

  if (products.length > 1) {
    await whatsapp.sendProductList(
      phoneNumberId,
      accessToken,
      customerNumber,
      products,
      responseText,
      "",
      language,
    );
    return;
  }

  await whatsapp.sendTextMessage(
    phoneNumberId,
    accessToken,
    customerNumber,
    responseText,
  );
}

/**
 * Customer tapped "Pick this one" on a product card. No AI round-trip needed:
 * resolve the product from the button id, remember it as the session's
 * lastProduct, and send its full card with a next-step prompt.
 */
async function handleProductSelection({
  phoneNumberId,
  accessToken,
  businessId,
  customerNumber,
  productId,
}) {
  const product = await productService.getProductById(productId);
  const language = getSession(businessId, customerNumber).language;

  if (!product) {
    await whatsapp.sendTextMessage(
      phoneNumberId,
      accessToken,
      customerNumber,
      await tr(language, (s) => s.productGone),
    );
    return;
  }

  setLastProduct(businessId, customerNumber, product);

  const followUpText = product.is_food
    ? await tr(language, (s) =>
        s.pickedFood(product.name, product.prep_time_mins),
      )
    : await tr(language, (s) => s.pickedRetail(product.name));

  const [localized] = await localizeProductsForLanguage([product], language);

  await whatsapp.sendProductCard(
    phoneNumberId,
    accessToken,
    customerNumber,
    localized,
    followUpText,
    language,
  );

  const currentSession = getSession(businessId, customerNumber);

  setSession(businessId, customerNumber, {
    ...currentSession,
    conversationHistory: buildConversationHistory(
      currentSession.conversationHistory || [],
      `I picked this product: ${product.name}`,
      followUpText,
    ),
    lastMessageAt: new Date(),
  });
}

async function extractUserMessage(message, accessToken, business) {
  try {
    if (message.type === "text") {
      return message.text?.body?.trim() || "";
    }

    // Other interactive replies (non-product buttons / list picks): treat the
    // tapped label as the customer's message.
    if (message.type === "interactive") {
      const reply =
        message.interactive?.button_reply || message.interactive?.list_reply;
      return reply?.title?.trim() || "";
    }

    if (message.type === "voice" || message.type === "audio") {
      const mediaId = message.voice?.id || message.audio?.id;

      if (!mediaId) {
        throw new Error("No media ID found for audio message");
      }

      const audioData = await whatsapp.downloadMedia(mediaId, accessToken);

      const transcription = await openaiService.transcribeAudio(
        audioData,
        business,
      );

      if (!transcription) {
        throw new Error("Empty transcription");
      }

      return transcription.trim();
    }

    return "";
  } catch (error) {
    logger.error("[Voice Error]", error);

    return "__VOICE_ERROR__";
  }
}

async function executeAction({
  action,
  businessId,
  customerNumber,
  session,
  shownProductIds = new Set(),
}) {
  let actionResult = null;
  let productsToShow = [];
  let asPickableCards = false; // search results carry a "Pick this one" button

  switch (action.type) {
    case "search_products": {
      const query = action.data.query?.trim();

      if (!query) {
        actionResult = createDefaultActionResult(
          "I could not tell what to search for. Please mention the product, category, or what you want to use it for.",
        );
        break;
      }

      // A broad "what do you have?" browse (query "*") lists the catalog as
      // numbered text, 10 per page. A specific enquiry shows pickable image
      // cards, 4 per page.
      const isBroadBrowse = query === "*";
      const pageSize = isBroadBrowse ? BROWSE_PAGE_SIZE : SEARCH_PAGE_SIZE;

      const { products: allMatches, specificity: searchBreadth } =
        await productService.searchProducts(
          businessId,
          query,
          isBroadBrowse ? BROWSE_LIMIT : SEARCH_LIMIT,
        );

      // Budget refinement ("cheaper ones", "under 15k"): keep the same
      // category matches the search returned, just drop anything above the
      // customer's limit. The category stays intact — we never swap in
      // unrelated items to fill the page.
      const maxPrice =
        typeof action.data.maxPrice === "number" && action.data.maxPrice > 0
          ? action.data.maxPrice
          : null;
      const found = maxPrice
        ? allMatches.filter(
            (p) => typeof p.price === "number" && p.price <= maxPrice,
          )
        : allMatches;

      logger.info(
        `[Search] "${query}"${maxPrice ? ` (≤₦${maxPrice})` : ""} → ${found.length} match(es) for business ${businessId}`,
      );

      // Results arrive ordered by matchPercent. The strong tier (≥90%) is
      // what the customer literally asked for; everything below is "close".
      const strongCount = isBroadBrowse
        ? found.length
        : found.filter((p) => (p.matchPercent ?? 100) >= STRONG_MATCH_PERCENT)
            .length;

      // Page 1 never mixes tiers: with 1–3 strong matches, show ONLY those —
      // the lower-tier items are announced as "other items you might like"
      // instead of padding the page. With more strong matches than fit, or
      // none at all, page normally from the top of the list.
      const productsToDisplay =
        !isBroadBrowse && strongCount > 0 && strongCount < pageSize
          ? found.slice(0, strongCount)
          : found.slice(0, pageSize);
      const remainingCount = Math.max(
        found.length - productsToDisplay.length,
        0,
      );

      // True when everything left beyond this page is lower-tier — switches
      // the appended hint from "N more items" to "N other items you might like".
      const remainingAreSuggestions =
        !isBroadBrowse &&
        strongCount > 0 &&
        remainingCount > 0 &&
        strongCount <= productsToDisplay.length;

      // A partial match (specific search, no strong/exact fit) is NOT shown as
      // cards — we send only an honest text message. Cards are reserved for
      // strong matches; a broad browse stays a numbered text list.
      const isPartialMatch =
        !isBroadBrowse && found.length > 0 && strongCount === 0;

      if (found.length > 0) {
        setLastProduct(businessId, customerNumber, found[0]);
        if (!isBroadBrowse && strongCount > 0) {
          productsToShow = productsToDisplay;
          asPickableCards = true;
        }
      }

      const currentSession = getSession(businessId, customerNumber);

      setSession(businessId, customerNumber, {
        ...currentSession,
        browseMode: "search",
        lastSearch: {
          query,
          productIds: found.map((product) => product.id),
          // Nothing was shown for a partial match, so a later "show more" starts
          // from the top rather than skipping the first page.
          offset: isPartialMatch ? 0 : productsToDisplay.length,
          strongCount,
        },
      });

      actionResult = {
        query,
        count: found.length,
        shownCount: isPartialMatch ? 0 : productsToDisplay.length,
        // Partial matches show nothing, so there is no "show more" to offer.
        remainingCount: isPartialMatch ? 0 : remainingCount,
        remainingAreSuggestions,
        // "strong": the shown products are what the customer asked for.
        // "partial": nothing matched closely — these are the nearest fits.
        matchTier: isBroadBrowse
          ? undefined
          : strongCount > 0
            ? "strong"
            : "partial",
        // "broad": bare-type query → present a selection and invite narrowing.
        // "specific": constraints given → match precisely or be honest.
        searchBreadth,
        startNumber: 1,
        // "cards" for strong matches, "text" for a broad browse, "none" for a
        // partial match (message only — no product list, no cards).
        displayMode: isBroadBrowse
          ? "text"
          : strongCount > 0
            ? "cards"
            : "none",
        products: productsToDisplay.map(mapProductForAI),
        // Budget context so the reply can say "here are <category> within your
        // budget" — and, when nothing fits, stay in-category instead of drifting.
        ...(maxPrice
          ? {
              budget: maxPrice,
              // The category had items, just none under their limit.
              noneWithinBudget: found.length === 0 && allMatches.length > 0,
              cheapestInCategory:
                found.length === 0 && allMatches.length > 0
                  ? (allMatches
                      .map((p) => p.price)
                      .filter((n) => typeof n === "number")
                      .sort((a, b) => a - b)[0] ?? null)
                  : null,
            }
          : {}),
      };

      break;
    }

    case "show_more_products": {
      const currentSession = getSession(businessId, customerNumber);

      // Text-only pagination for the "similar negotiable" alternatives list.
      if (
        currentSession.browseMode === "similar" &&
        currentSession.similarSearch?.productIds?.length
      ) {
        const similar = currentSession.similarSearch;
        const allSimilar = await productService.getProductsByIds(
          similar.productIds,
        );

        const start = similar.offset || 0;
        const nextSimilar = allSimilar.slice(start, start + SIMILAR_PAGE_SIZE);
        const newOffset = start + nextSimilar.length;
        const remainingCount = Math.max(allSimilar.length - newOffset, 0);

        setSession(businessId, customerNumber, {
          ...currentSession,
          similarSearch: { ...similar, offset: newOffset },
        });

        actionResult = nextSimilar.length
          ? {
              similar: true,
              count: allSimilar.length,
              shownCount: nextSimilar.length,
              remainingCount,
              products: nextSimilar.map(mapProductForAI),
            }
          : createDefaultActionResult(
              "That's all the similar items I have for now.",
            );

        productsToShow = []; // text only — no product images for alternatives
        break;
      }

      const lastSearch = currentSession.lastSearch;

      if (!lastSearch?.productIds?.length) {
        actionResult = createDefaultActionResult(
          "There is no previous product search to continue. Please tell me what you are looking for.",
        );
        break;
      }

      const allProducts = await productService.getProductsByIds(
        lastSearch.productIds,
      );

      // Match the original browse type: numbered text pages of 10 for a broad
      // "*" browse, pickable image cards of 4 for a specific search.
      const isBroadBrowse = lastSearch.query === "*";
      const pageSize = isBroadBrowse ? BROWSE_PAGE_SIZE : SEARCH_PAGE_SIZE;

      const start = lastSearch.offset || 0;

      // After SEARCH_MAX_CARD_PAGES pages of cards, stop paginating in chat:
      // when products still remain, hand the customer off to the business's
      // online store, where the whole catalog is browsable.
      if (
        !isBroadBrowse &&
        start >= SEARCH_PAGE_SIZE * SEARCH_MAX_CARD_PAGES &&
        allProducts.length > start
      ) {
        const business = getBusinessById(businessId);
        actionResult = {
          storeHandoff: true,
          query: lastSearch.query,
          moreProductsCount: allProducts.length - start,
          storeLink: `${STORE_URL_BASE}/${business?.velteUserId || businessId}`,
        };
        break;
      }

      const nextProducts = allProducts.slice(start, start + pageSize);
      const newOffset = start + nextProducts.length;
      const remainingCount = Math.max(allProducts.length - newOffset, 0);

      // Once pagination has moved past the strong tier, what's left is the
      // lower-match tier — keep the "other items you might like" framing.
      const strongCount = lastSearch.strongCount ?? 0;
      const remainingAreSuggestions =
        !isBroadBrowse &&
        strongCount > 0 &&
        remainingCount > 0 &&
        newOffset >= strongCount;

      if (nextProducts.length > 0) {
        setLastProduct(businessId, customerNumber, nextProducts[0]);
        if (!isBroadBrowse) {
          productsToShow = nextProducts;
          asPickableCards = true;
        }
      }

      setSession(businessId, customerNumber, {
        ...currentSession,
        lastSearch: {
          ...lastSearch,
          offset: newOffset,
        },
      });

      actionResult = {
        query: lastSearch.query,
        count: allProducts.length,
        shownCount: nextProducts.length,
        remainingCount,
        remainingAreSuggestions,
        startNumber: start + 1, // continue the numbered list across pages
        displayMode: productsToShow.length ? "cards" : "text",
        products: nextProducts.map(mapProductForAI),
      };

      break;
    }

    case "check_attribute": {
      const { attributeKey, requestedValue } = action.data;
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : session.lastProduct;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I could not identify which product you mean. Please mention the product name.",
        );
        break;
      }

      // A follow-up about a product whose card was already shown this session
      // stays as plain chat — re-send the photo + details only the first time
      // this product comes up.
      const alreadyShown = shownProductIds.has(product.id);

      if (!attributeKey) {
        actionResult = createDefaultActionResult(
          `I found ${product.name}, but I could not tell which attribute you want to check.`,
        );
        setLastProduct(businessId, customerNumber, product);
        productsToShow = alreadyShown ? [] : [product];
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      const check = productService.checkAttribute(
        product,
        attributeKey,
        requestedValue,
      );

      actionResult = {
        product: product.name,
        attributeKey,
        requestedValue: requestedValue ?? null,
        ...check,
      };

      productsToShow = alreadyShown ? [] : [product];
      break;
    }

    case "generate_payment_link": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "Product not found. Please tell me exactly which product you want to buy.",
        );
        break;
      }

      // If the customer haggled on this item, the order must close at the agreed
      // price, not the list price — even when the model routes the "I'll take it"
      // to generate_payment_link rather than accept_offer.
      const negotiatedPrice = resolveAgreedPrice(
        getSession(businessId, customerNumber),
        product,
      );

      // Gather variant choices, required modifiers, name, email and location —
      // asking for whatever's still missing — and only place the order once the
      // checkout is complete.
      actionResult = await gatherCheckoutOrAsk({
        businessId,
        customerNumber,
        product,
        data: action.data,
        negotiatedPrice,
      });

      break;
    }

    case "start_negotiation": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I could not tell which product you want to negotiate on. Please mention the product name.",
        );
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      // Rule B — fixed-price product: don't haggle, offer alternatives instead.
      if (!product.allow_negotiation) {
        logger.warn(
          `[Negotiation] "${product.name}" resolved as NON-negotiable (allow_negotiation=${product.allow_negotiation}, ` +
            `price=₦${product.price}, min_price=${product.min_price ?? "none"}). ` +
            `If this product IS negotiable in Velte, its negotiable flag isn't reaching us (field/value mismatch).`,
        );
        clearNegotiation(businessId, customerNumber);
        actionResult = {
          nonNegotiable: true,
          product: product.name,
          price: product.price,
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // The customer is asking us to come down but hasn't named a number
      // ("abeg reduce am", "how much last?", "do better"). Rather than just
      // restate the list price (which read as "the system won't budge"), we make
      // the move ourselves: open below list and cut deeper on every press, never
      // below the hidden floor. A stale negotiation for a DIFFERENT product is
      // reset; an existing one for THIS product is pressed further so a quoted
      // price is never forgotten and a counter never jumps back UP.
      let negotiation = getSession(businessId, customerNumber).negotiation;
      if (!negotiation || negotiation.productId !== product.id) {
        negotiation = startNegotiation(businessId, customerNumber, product);
      }

      const decision = concede(negotiation);
      setNegotiation(businessId, customerNumber, decision.negotiation);
      logger.info(
        `[Negotiation] start_negotiation press "${product.name}" → ${decision.outcome} ` +
          `₦${(decision.counterPrice ?? decision.finalPrice ?? 0).toLocaleString()} (list ₦${product.price.toLocaleString()})`,
      );

      if (decision.outcome === "final") {
        actionResult = {
          negotiation: {
            outcome: "final",
            finalPrice: decision.finalPrice,
            listPrice: product.price,
            product: product.name,
          },
          product: mapProductForAI(product),
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // NOTE: never expose minPrice — it stays server-side only.
      actionResult = {
        negotiation: {
          outcome: "counter",
          counterPrice: decision.counterPrice,
          listPrice: product.price,
          round: decision.negotiation.rounds,
          product: product.name,
        },
        product: mapProductForAI(product),
      };
      productsToShow = [];
      break;
    }

    case "make_offer": {
      const freshSession = getSession(businessId, customerNumber);
      let activeNegotiation = freshSession.negotiation;

      // The offer is about the product currently in focus. Prefer lastProduct so a
      // FINISHED/stale negotiation on a PREVIOUS product (e.g. one that reached its
      // "final" price and was never cleared) can't hijack a fresh offer on a new
      // item. During a normal ongoing negotiation these are the same product
      // (make_offer/start_negotiation keep lastProduct in sync), so this only
      // changes behaviour once the customer has moved on. Fall back to the active
      // negotiation's product only when there's no current focus.
      const productName =
        freshSession.lastProduct?.name ||
        activeNegotiation?.productName ||
        null;

      const product = productName
        ? await productService.getProductByName(businessId, productName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I could not tell which product you want to negotiate on. Please mention the product name.",
        );
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      // Rule B — fixed-price product: explain and offer alternatives.
      if (!product.allow_negotiation) {
        logger.warn(
          `[Negotiation] "${product.name}" resolved as NON-negotiable (allow_negotiation=${product.allow_negotiation}, ` +
            `price=₦${product.price}, min_price=${product.min_price ?? "none"}). ` +
            `If this product IS negotiable in Velte, its negotiable flag isn't reaching us (field/value mismatch).`,
        );
        clearNegotiation(businessId, customerNumber);
        actionResult = {
          nonNegotiable: true,
          product: product.name,
          price: product.price,
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // Start a negotiation lazily if none is active for THIS product.
      if (!activeNegotiation || activeNegotiation.productId !== product.id) {
        activeNegotiation = startNegotiation(
          businessId,
          customerNumber,
          product,
        );
      }

      // "26" on a ₦30,000 product means ₦26,000 — rescue shorthand the model
      // passed through literally before the engine prices it as an insult bid.
      const offer = openaiService.scaleOfferToContext(
        action.data.offer,
        product.price,
      );

      const decision = evaluateOffer(activeNegotiation, offer);
      setNegotiation(businessId, customerNumber, decision.negotiation);
      logger.info(
        `[Negotiation] make_offer "${product.name}" offer=₦${Number(offer).toLocaleString()} → ${decision.outcome} ` +
          `₦${(decision.counterPrice ?? decision.acceptedPrice ?? decision.finalPrice ?? 0).toLocaleString()} ` +
          `(list ₦${product.price.toLocaleString()})`,
      );

      // Rule F — accepted price: hand off to the same checkout gate as a direct
      // buy, at the agreed price, so variant choices and buyer details are still
      // gathered before the order is placed. If anything's missing this returns
      // needsInfo and the negotiation stays alive until it's complete.
      if (decision.outcome === "accept") {
        const checkout = await gatherCheckoutOrAsk({
          businessId,
          customerNumber,
          product,
          data: action.data,
          negotiatedPrice: decision.acceptedPrice,
        });

        if (checkout.needsInfo) {
          actionResult = checkout;
          break;
        }

        clearNegotiation(businessId, customerNumber);

        actionResult = {
          negotiation: {
            outcome: "accept",
            acceptedPrice: decision.acceptedPrice,
            product: product.name,
          },
          ...checkout,
          negotiated: true,
          agreedPrice: decision.acceptedPrice,
        };
        break;
      }

      // The customer keeps bidding under the hidden floor — the floor is now
      // quoted openly as the take-it-or-leave-it final price.
      if (decision.outcome === "final") {
        actionResult = {
          negotiation: {
            outcome: "final",
            finalPrice: decision.finalPrice,
            listPrice: product.price,
            product: product.name,
          },
          suggestSimilar: true,
        };
        productsToShow = [];
        break;
      }

      // Counter — provide the product's real qualities so the model can justify
      // the number. The hidden floor is never included.
      actionResult = {
        negotiation: {
          outcome: "counter",
          counterPrice: decision.counterPrice,
          listPrice: product.price,
          round: decision.negotiation.rounds,
          product: product.name,
        },
        product: mapProductForAI(product),
      };
      productsToShow = [];
      break;
    }

    case "accept_offer": {
      const freshSession = getSession(businessId, customerNumber);
      const negotiation = freshSession.negotiation;

      const productName =
        negotiation?.productName || freshSession.lastProduct?.name || null;
      const product = productName
        ? await productService.getProductByName(businessId, productName)
        : null;

      if (!product) {
        actionResult = createDefaultActionResult(
          "I lost track of which product we were negotiating. Please tell me the product name.",
        );
        break;
      }

      // The agreed price is the last price WE offered, then the customer's
      // latest offer, then the AI-detected final price. Clamp to [floor, list]
      // so we never close below the hidden floor or above the list price.
      const floor = negotiation?.minPrice ?? 0;
      let agreedPrice =
        negotiation?.lastCounter ??
        negotiation?.currentOffer ??
        action.data.finalPrice ??
        product.price;
      agreedPrice = Math.min(Math.max(agreedPrice, floor), product.price);

      // Same checkout gate as a direct buy, but at the agreed (negotiated) price.
      // If buyer details are still missing this returns needsInfo and we keep the
      // negotiation alive; once everything's in, the order is placed.
      const checkout = await gatherCheckoutOrAsk({
        businessId,
        customerNumber,
        product,
        data: action.data,
        negotiatedPrice: agreedPrice,
      });

      if (checkout.needsInfo) {
        actionResult = checkout;
        break;
      }

      clearNegotiation(businessId, customerNumber);

      actionResult = {
        negotiation: {
          outcome: "accept",
          acceptedPrice: agreedPrice,
          product: product.name,
        },
        ...checkout,
        negotiated: true,
        agreedPrice,
      };

      break;
    }

    case "find_similar_negotiable": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const baseProduct = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : session.lastProduct;

      if (!baseProduct) {
        actionResult = createDefaultActionResult(
          "Tell me which product you'd like alternatives for and I'll find similar items you can negotiate on.",
        );
        break;
      }

      const similar = await productService.findSimilarNegotiableProducts(
        businessId,
        baseProduct,
      );

      const currentSession = getSession(businessId, customerNumber);

      if (!similar.length) {
        setSession(businessId, customerNumber, {
          ...currentSession,
          similarSearch: null,
        });
        actionResult = {
          similar: true,
          baseProduct: baseProduct.name,
          count: 0,
          shownCount: 0,
          remainingCount: 0,
          products: [],
        };
        productsToShow = [];
        break;
      }

      const shown = similar.slice(0, SIMILAR_PAGE_SIZE);
      const remainingCount = Math.max(similar.length - shown.length, 0);

      setSession(businessId, customerNumber, {
        ...currentSession,
        browseMode: "similar",
        similarSearch: {
          baseProductId: baseProduct.id,
          productIds: similar.map((p) => p.id),
          offset: shown.length,
        },
      });

      actionResult = {
        similar: true,
        baseProduct: baseProduct.name,
        count: similar.length,
        shownCount: shown.length,
        remainingCount,
        products: shown.map(mapProductForAI),
      };
      productsToShow = []; // text only — no product images for alternatives
      break;
    }

    case "list_categories": {
      const categories = await productService.getProductCategories(businessId);

      if (!categories.length) {
        actionResult = {
          message: "No products available yet.",
          categories: [],
        };
        break;
      }

      actionResult = {
        message: "Available product categories",
        categories,
        count: categories.length,
      };

      productsToShow = []; // no product cards

      break;
    }

    case "send_product_image": {
      const resolvedProductName = getResolvedProductName(action.data, session);

      const product = resolvedProductName
        ? await productService.getProductByName(businessId, resolvedProductName)
        : session.lastProduct;

      if (!product) {
        actionResult = createDefaultActionResult(
          "Tell me which product you'd like to see and I'll send its picture and details.",
        );
        break;
      }

      setLastProduct(businessId, customerNumber, product);

      const hasImage = whatsapp.sendableImageUrl(product) !== null;

      // A product card sends the photo (when available) WITH the full details;
      // the AI reply rides along as a short friendly note. This is the only
      // action that sends an image.
      productsToShow = [product];

      actionResult = {
        product: product.name,
        price: product.price,
        hasImage,
      };
      break;
    }

    case "none":
    default:
      actionResult = null;
      break;
  }

  return { actionResult, productsToShow, asPickableCards };
}

export async function handleIncomingMessage(req, res) {
  res.sendStatus(200);

  // Set as soon as we know who to reply to, so the catch block can still
  // answer the customer if anything below throws.
  let replyContext = null;

  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;

    // Delivery receipts (sent/delivered/read/failed). A failed status is the
    // ONLY signal Meta gives when it accepts a message (HTTP 200) but cannot
    // deliver it — e.g. an unsupported media type — so log it loudly instead
    // of dropping it with the other receipts.
    if (value?.statuses?.length) {
      for (const status of value.statuses) {
        if (status.status === "failed") {
          const details = (status.errors || [])
            .map(
              (e) =>
                `${e.code} ${e.title}${e.error_data?.details ? ` — ${e.error_data.details}` : ""}`,
            )
            .join("; ");
          logger.error(
            `[Webhook] Delivery FAILED to ${status.recipient_id} (message ${status.id}): ${details || "no error details"}`,
          );
        }
      }
      return;
    }

    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const customerNumber = message.from;
    const phoneNumberId = value.metadata?.phone_number_id;
    const messageId = message.id;

    if (!customerNumber || !phoneNumberId) {
      logger.warn("[Webhook] Missing customerNumber or phoneNumberId");
      return;
    }

    const business = getBusinessByPhoneNumberId(phoneNumberId);

    if (!business) {
      logger.warn(
        `[Webhook] No business found for phone_number_id: ${phoneNumberId}`,
      );
      return;
    }

    const { access_token: accessToken, id: businessId } = business;

    // Load this customer's saved session from Mongo into the cache before any
    // synchronous read below — this is what makes absence detection (and the
    // rest of the session) survive a process restart.
    await hydrateSession(businessId, customerNumber);

    replyContext = {
      phoneNumberId,
      accessToken,
      customerNumber,
      language: getSession(businessId, customerNumber).language,
    };

    // Mark read and show the "typing…" bubble before we start composing, so the
    // customer sees activity while the AI works (it auto-clears when we reply).
    await whatsapp.sendTypingIndicator(phoneNumberId, accessToken, messageId);

    // "Pick this one" tap on a product card — resolve it directly.
    const buttonReply =
      message.type === "interactive"
        ? message.interactive?.button_reply || message.interactive?.list_reply
        : null;

    if (buttonReply?.id?.startsWith("select_product:")) {
      await handleProductSelection({
        phoneNumberId,
        accessToken,
        businessId,
        customerNumber,
        productId: buttonReply.id.slice("select_product:".length),
      });
      return;
    }

    const userMessage = await extractUserMessage(
      message,
      accessToken,
      business,
    );

    if (userMessage === "__VOICE_ERROR__") {
      // Generate smart AI fallback message
      const fallback = await openaiService.generateVoiceErrorMessage(
        business,
        replyContext.language,
      );

      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        fallback,
      );

      return;
    }

    if (!userMessage) {
      logger.warn(
        `[${business.name}] Empty or unsupported message from ${customerNumber}`,
      );

      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        await tr(replyContext.language, (s) => s.notUnderstood),
      );

      return;
    }

    const session = getSession(businessId, customerNumber);

    // The customer is back and engaging, so cancel any armed abandoned-checkout
    // follow-up. If this very turn generates a fresh payment link, runCheckout
    // re-arms it; if they're just chatting or asking about another product, it
    // stays cancelled and the sweeper never nudges them.
    if (session.pendingFollowUp) {
      clearPendingFollowUp(businessId, customerNumber);
    }

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const absenceMs = session.lastMessageAt
      ? Date.now() - new Date(session.lastMessageAt).getTime()
      : null;

    const isFirstVisit = !session.lastMessageAt;
    const isReturningAfterAbsence =
      absenceMs !== null && absenceMs > ONE_HOUR_MS;

    // A product card (image + full details) is only re-displayed when the buyer
    // turns to a DIFFERENT product. Once a product's card has been shown in this
    // conversation session, follow-up questions about that same item flow as
    // plain text. The set is reset when a new session begins (first visit, or a
    // return after a long absence).
    const newConversationSession = isFirstVisit || isReturningAfterAbsence;
    const shownProductIds = new Set(
      newConversationSession ? [] : session.shownProductIds || [],
    );

    let activeSession = session;
    let greetingWasSent = false;

    // The AI-config welcome message is reserved for the very first chat. The
    // "welcome back" for a returning customer is deferred until AFTER we know
    // what they said (handled post-classification, below): it is sent only when
    // their return message isn't itself a request. A return that asks for
    // something skips the greeting entirely and flows straight to the answer —
    // no filler "I'm pulling it up" bubble.
    let greeting = null;

    if (isFirstVisit) {
      // A configured greeting is shown verbatim; an AI-generated one bridges into
      // whatever the customer just asked for so it isn't a disconnected line.
      greeting =
        business.aiConfig?.greetingMessage?.trim() ||
        (await openaiService.generateGreeting(
          "first_visit",
          business,
          session.language,
          userMessage,
        ));
    }

    if (greeting) {
      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        greeting,
      );
      await new Promise((r) => setTimeout(r, 600));

      // Sending the greeting cleared the typing bubble — re-trigger it (same
      // inbound message id) so the customer sees "typing…" again while we
      // compose the actual reply. Clears once more when that reply goes out.
      await whatsapp.sendTypingIndicator(phoneNumberId, accessToken, messageId);

      greetingWasSent = true;
      activeSession = {
        ...session,
        conversationHistory: [
          ...(session.conversationHistory || []),
          { role: "assistant", content: greeting },
        ],
      };
    }

    const rawAiOutput = await openaiService.processMessage(
      userMessage,
      activeSession,
      business,
    );

    const aiOutput = openaiService.normalizeAiOutput(
      rawAiOutput,
      activeSession,
    );
    let action = aiOutput.action;
    const language = aiOutput.language;
    replyContext.language = language;

    // Safety net: mid-negotiation, a message carrying a money amount IS a bid.
    // If the model still failed to classify it, route it to the engine rather
    // than letting a stalling "none" reply go out. The list price anchors
    // shorthand: "make I run am 26" on a ₦30,000 item reads as ₦26,000.
    if (action.type === "none" && session.negotiation) {
      const fallbackOffer = openaiService.extractOfferAmount(
        userMessage,
        session.negotiation.originalPrice || session.lastProduct?.price || null,
      );
      if (fallbackOffer !== null) {
        action = { type: "make_offer", data: { offer: fallbackOffer } };
        logger.info(
          `[${business.name}] Bid fallback: reclassified "none" as make_offer(₦${fallbackOffer})`,
        );
      }
    }

    // Quantity safety net. The model frequently omits the unit count even when
    // the customer clearly stated one ("I want 3"), which silently bills and
    // stores the order as a single unit. This only ever second-guesses a SINGLE
    // -line order — a multi-variant breakdown ("3 red + 1 black") is the model's
    // to split into items, and extractQuantity already declines ambiguous multi
    // -count messages. Trust the model's per-line count when it set one; otherwise
    // recover it from the raw message: fill it into this turn's single line, and
    // persist it as pendingQuantity so a count given on an EARLIER turn (while
    // browsing, negotiating, or giving details) still applies when the order
    // closes. In a confirmed checkout turn even a bare "3" is a quantity (the
    // intent disambiguates it); elsewhere an explicit cue is required, and pure
    // browse/search turns never overwrite the remembered quantity.
    const isCheckoutAction = CHECKOUT_ACTIONS.has(action.type);
    const lineItems =
      isCheckoutAction && Array.isArray(action.data?.items)
        ? action.data.items
        : [];
    const singleLine = lineItems.length <= 1;
    const modelQuantity = singleLine
      ? normalizeQuantity(lineItems[0]?.quantity)
      : null;
    const statedQuantity = singleLine
      ? (modelQuantity ??
        openaiService.extractQuantity(userMessage, {
          allowBare: isCheckoutAction,
        }))
      : null;
    if (statedQuantity != null) {
      if (isCheckoutAction && modelQuantity == null) {
        const line = { ...(lineItems[0] || {}), quantity: statedQuantity };
        action.data = { ...action.data, items: [line] };
        logger.info(
          `[${business.name}] Quantity fallback: recovered ×${statedQuantity} from message`,
        );
      }
      if (!QUANTITY_PERSIST_BLOCKED.has(action.type)) {
        const s = getSession(businessId, customerNumber);
        setSession(businessId, customerNumber, {
          ...s,
          checkout: { ...(s.checkout || {}), pendingQuantity: statedQuantity },
        });
      }
    }

    logger.info(
      `[${business.name}] Normalized action: ${action.type} (language: ${language})`,
    );

    let responseText = stripInternalMarkers(aiOutput.response);

    // Returning after a long absence: greet only when the message isn't itself a
    // request. A bare return ("hi", "you dey?") gets a warm welcome-back as the
    // whole reply; a return that asks for something falls through to the answer
    // below with no separate greeting bubble. Uses this turn's detected language.
    if (isReturningAfterAbsence && action.type === "none") {
      responseText =
        (await openaiService.generateGreeting(
          "welcome_back",
          business,
          language,
        )) || responseText;
    }

    if (action.type !== "none") {
      const { actionResult, productsToShow, asPickableCards } =
        await executeAction({
          action,
          businessId,
          customerNumber,
          session,
          shownProductIds,
        });

      const freshSession = getSession(businessId, customerNumber);

      // The "show more" hint is AI-written but code-guarded: code decides the
      // exact count and whether to show it at all (it must only ever appear when
      // items genuinely remain), the model only phrases it naturally, and a bad
      // generation falls back to the fixed template. When everything left is a
      // lower-tier match, it's framed as suggestions instead of more results.
      const remainingCount = actionResult?.remainingCount;
      const moreItemsHint =
        typeof remainingCount === "number" && remainingCount > 0
          ? await composeMoreItemsHint({
              count: remainingCount,
              asSuggestions: !!actionResult?.remainingAreSuggestions,
              language,
              business,
            })
          : null;

      const sendingCards = asPickableCards && productsToShow.length > 0;

      if (sendingCards) {
        // Strong, specific matches: the cards speak for themselves — no intro
        // bubble. A BROAD search (a wide selection that should invite narrowing)
        // gets a short AI intro line before the cards. (Partial matches never
        // reach this branch — they're sent as a message only, no cards.)
        const needsIntro = actionResult?.searchBreadth === "broad";

        let introText = "";
        if (needsIntro) {
          const composed = await openaiService.generateResponseWithActionResult(
            userMessage,
            { ...freshSession, language },
            actionResult,
            business,
          );
          introText = stripInternalMarkers(composed.response);
        }

        const localizedCards = await localizeProductsForLanguage(
          productsToShow,
          language,
        );

        // The intro (when needed) is the header bubble; the more-items hint
        // goes out after the last card.
        await whatsapp.sendProductList(
          phoneNumberId,
          accessToken,
          customerNumber,
          localizedCards,
          introText,
          moreItemsHint || "",
          language,
        );

        // History note (never sent) so follow-ups like "the second one" or
        // "the jollof" stay grounded in exactly what was shown.
        responseText = `${introText ? `${introText}\n` : ""}[Sent product cards: ${productsToShow
          .map((p) => p.name)
          .join(", ")}]${moreItemsHint ? ` ${moreItemsHint}` : ""}`;
      } else {
        // Counter/final negotiation prices are decided by the engine and sent
        // verbatim — the reply model has been seen to override them and refuse
        // the customer, so it never gets to pick the number.
        const negReply = await composeNegotiationReply(
          language,
          actionResult?.negotiation,
        );

        if (negReply) {
          responseText = negReply;
        } else {
          // The stored session still has last turn's language — inject this
          // turn's detection so the reply switches languages without lag.
          const finalAiOutput =
            await openaiService.generateResponseWithActionResult(
              userMessage,
              { ...freshSession, language },
              actionResult,
              business,
            );

          responseText = stripInternalMarkers(finalAiOutput.response);

          // Force the exact payment URL in (the model isn't trusted to render it).
          if (actionResult?.paymentLink) {
            responseText = enforcePaymentLink(
              responseText,
              actionResult.paymentLink,
            );
          }
        }

        if (moreItemsHint) {
          responseText += `\n\n${moreItemsHint}`;
        }

        await sendOutboundMessage({
          phoneNumberId,
          accessToken,
          customerNumber,
          responseText,
          productsToShow,
          language,
        });
      }

      // Remember every card we just put on screen so later questions about the
      // same item stay text-only.
      for (const p of productsToShow) {
        if (p?.id != null) shownProductIds.add(p.id);
      }
    } else if (!greetingWasSent) {
      await whatsapp.sendTextMessage(
        phoneNumberId,
        accessToken,
        customerNumber,
        responseText,
      );
    }

    const currentSession = getSession(businessId, customerNumber);

    // Spread the whole session so fields written during executeAction
    // (browseMode, similarSearch, ...) survive the turn.
    setSession(businessId, customerNumber, {
      ...currentSession,
      conversationHistory: buildConversationHistory(
        currentSession.conversationHistory || [],
        userMessage,
        responseText,
      ),
      shownProductIds: [...shownProductIds],
      language,
      lastMessageAt: new Date(),
    });

    logger.info(`[${business.name}] → replied to ${customerNumber}`);
  } catch (error) {
    // Meta/axios errors carry the useful detail in response.data
    logger.error("[Webhook] Unhandled error:", error.response?.data || error);

    // Never leave the customer on read — always attempt a fallback reply.
    if (replyContext) {
      try {
        await whatsapp.sendTextMessage(
          replyContext.phoneNumberId,
          replyContext.accessToken,
          replyContext.customerNumber,
          t(replyContext.language).somethingWrong,
        );
      } catch {
        // the send channel itself is down — nothing more we can do
      }
    }
  }
}
