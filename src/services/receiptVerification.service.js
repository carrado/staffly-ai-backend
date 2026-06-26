import * as openaiService from "./openai.service.js";
import { logger } from "../utils/logger.js";

/**
 * Receipt verification — confirms a buyer's uploaded bank-transfer receipt against
 * their order. Hybrid + cost-optimized: free OCR (tesseract.js) first, falling
 * back to gpt-4o-mini vision ONLY when OCR can't read the essentials. The actual
 * decision is deterministic (amount + beneficiary account must match the order /
 * the vendor's saved account), so it costs nothing beyond reading the image.
 */

// Lazy, cached dynamic import so the (optional) OCR dependency never blocks
// startup. If tesseract.js isn't installed, OCR is skipped and we go straight to
// the vision fallback — the pipeline still works, just without the free first pass.
let tesseractPromise;
async function getTesseract() {
  if (tesseractPromise === undefined) {
    tesseractPromise = import("tesseract.js").catch((e) => {
      logger.warn(
        `[Receipt] tesseract.js unavailable — OCR disabled, using vision only: ${e.message}`,
      );
      return null;
    });
  }
  return tesseractPromise;
}

const digits = (v) => (v == null ? "" : String(v).replace(/\D/g, ""));
// A reference is only trustworthy for dedupe if it looks like a real transaction
// id (has a digit, reasonably long) — otherwise treat as none (no dedupe is safer
// than dedupe on a bogus value shared across receipts).
const cleanReference = (r) =>
  r && /\d/.test(String(r)) && String(r).length >= 8 ? String(r) : null;
const toNumber = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function ocrText(buffer) {
  const mod = await getTesseract();
  if (!mod) return null;
  try {
    const Tesseract = mod.default || mod;
    const { data } = await Tesseract.recognize(buffer, "eng");
    return data?.text || null;
  } catch (e) {
    logger.warn(`[Receipt] OCR failed: ${e.message}`);
    return null;
  }
}

// Best-effort field parse from raw OCR text. Heuristic by design — vision is the
// backstop for anything this misses.
function parseOcrFields(text) {
  if (!text) return { amount: null, accountNumber: null, reference: null };
  const t = text.replace(/\s+/g, " ");

  // Match only money-SHAPED values — grouped thousands ("18,360") or a 2-decimal
  // value ("18360.00") — so a bare "N" can't latch onto a transaction ref/ID
  // (e.g. "Ref N12345678") and hand back a bogus non-null "amount". A wrong-but-
  // non-null amount is the dangerous case: it satisfies the OCR gate, skips the
  // vision re-check, and falsely rejects a genuine receipt. Order: an explicitly
  // labelled "amount" (most reliable — also allows a plain integer here), then
  // ₦/NGN, then a bare uppercase N directly tied to a money-shaped number.
  const MONEY = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+\\.\\d{2}";
  const MONEY_LABELLED = `${MONEY}|\\d+`;
  const amtMatch =
    t.match(new RegExp(`amount[:\\s]*(?:₦|NGN|N)?\\s?(${MONEY_LABELLED})`, "i")) ||
    t.match(new RegExp(`(?:₦|NGN)\\s?(${MONEY})`, "i")) ||
    t.match(new RegExp(`\\bN\\s?(${MONEY})`));
  const amount = amtMatch ? toNumber(amtMatch[1]) : null;

  // Prefer a 10-digit number tied to the beneficiary/recipient, else any 10-digit.
  const acctNear = t.match(
    /(?:beneficiary|recipient|to|credit(?:ed)?|account(?:\s*(?:number|no\.?))?)[^\d]{0,24}(\d{10})/i,
  );
  const anyAcct = acctNear || t.match(/\b(\d{10})\b/);
  const accountNumber = anyAcct ? anyAcct[1] : null;

  const refMatch = t.match(
    /(?:reference|ref|session|transaction(?:\s*id)?)[^\w]{0,6}([A-Za-z0-9]{6,})/i,
  );
  // Only trust a reference that looks like a real transaction id (has a digit and
  // is reasonably long). This avoids capturing words like "Successful", which
  // would otherwise poison dedupe (every receipt sharing one fake reference).
  let reference = refMatch ? refMatch[1] : null;
  if (reference && (reference.length < 8 || !/\d/.test(reference))) {
    reference = null;
  }

  return { amount, accountNumber, reference };
}

/**
 * Verify an uploaded receipt against an order.
 * @returns {{ ok:boolean, reason:string, source?:string, reference?:string|null, fields?:object, expected?:number, got?:number }}
 *   reasons: verified | unreadable | not_a_receipt | account_mismatch |
 *   amount_mismatch | no_vendor_account
 */
export async function verifyReceipt({ media, order, bankDetails }) {
  if (!bankDetails?.accountNumber) {
    return { ok: false, reason: "no_vendor_account" };
  }

  // 1) Free OCR pass.
  const text = await ocrText(media?.buffer);
  let fields = parseOcrFields(text);
  // Only the vision classifier can positively rule an image "not a receipt". A
  // matching amount + beneficiary account is itself strong proof, so we don't
  // hard-reject on OCR keyword heuristics (which would cause false negatives).
  let isReceipt = true;
  let source = "ocr";

  // We only trust OCR enough to SKIP vision when its read, on its own, fully
  // passes every deterministic check. If anything is missing OR would cause a
  // rejection (amount/account mismatch), tesseract isn't reliable enough to bounce
  // a possibly-genuine receipt on — escalate to the more accurate vision pass and
  // re-check, so a misread amount (e.g. "18,360" read as "16,360") can't reject a
  // correct receipt.
  const ocrPasses =
    fields.amount != null &&
    !!digits(fields.accountNumber) &&
    digits(fields.accountNumber) === digits(bankDetails.accountNumber) &&
    Math.round(fields.amount) === Math.round(order.amount);

  // 2) Vision fallback whenever OCR doesn't cleanly pass.
  if (!ocrPasses) {
    const vision = await openaiService.extractReceiptFieldsFromImage(
      media || {},
    );
    if (vision) {
      const hadOcrFields = fields.amount != null || !!digits(fields.accountNumber);
      source = hadOcrFields ? "hybrid" : "vision";
      const visionAmount = toNumber(vision.amount);
      const visionAccount = digits(vision.beneficiaryAccountNumber) || null;
      // Vision is authoritative on disagreement: prefer its read over OCR's (OCR
      // only got here because it was incomplete or mismatched), but fall back to
      // an OCR value for any field vision itself couldn't read.
      fields = {
        amount: visionAmount ?? fields.amount,
        accountNumber: visionAccount ?? (digits(fields.accountNumber) || null),
        reference: cleanReference(vision.reference ?? fields.reference),
      };
      if (typeof vision.isReceipt === "boolean") isReceipt = vision.isReceipt;
    }
  }

  // 3) Deterministic checks.
  if (isReceipt === false) {
    return { ok: false, reason: "not_a_receipt", source };
  }
  if (fields.amount == null || !digits(fields.accountNumber)) {
    return { ok: false, reason: "unreadable", source };
  }
  if (digits(fields.accountNumber) !== digits(bankDetails.accountNumber)) {
    return { ok: false, reason: "account_mismatch", source, fields };
  }
  if (Math.round(fields.amount) !== Math.round(order.amount)) {
    return {
      ok: false,
      reason: "amount_mismatch",
      source,
      fields,
      expected: order.amount,
      got: fields.amount,
    };
  }

  return {
    ok: true,
    reason: "verified",
    source,
    reference: fields.reference || null,
    fields,
  };
}
