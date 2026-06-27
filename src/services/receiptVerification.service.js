import * as openaiService from "./openai.service.js";

/**
 * Receipt verification — confirms a buyer's uploaded bank-transfer receipt against
 * their order. Vision-only: gpt-4o-mini reads the receipt (amount + beneficiary
 * account, and whether it's genuinely an untampered receipt at all), and the
 * decision is deterministic (the amount and beneficiary account must match the
 * order / the vendor's saved account).
 *
 * OCR (tesseract) was removed: a well-made fake receipt reads perfectly under OCR,
 * so it never caught a forgery — it only added cost and false rejects on misreads.
 * Vision is the more reliable reader AND the only thing that can positively rule an
 * image "not a receipt" or spot signs of tampering.
 *
 * IMPORTANT: passing here means the receipt LOOKS genuine and its figures match —
 * it is NOT proof the money arrived (a perfectly-rendered fake passes the same
 * checks). Every verified receipt is therefore held for the vendor to confirm
 * against their actual bank credit alert; nothing auto-confirms on vision alone.
 */

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

/**
 * Verify an uploaded receipt against an order — vision only.
 * @returns {{ ok:boolean, reason:string, source:string, reference?:string|null, fields?:object, expected?:number, got?:number }}
 *   reasons: verified | unreadable | not_a_receipt | account_mismatch |
 *   amount_mismatch | no_vendor_account
 */
export async function verifyReceipt({ media, order, bankDetails }) {
  if (!bankDetails?.accountNumber) {
    return { ok: false, reason: "no_vendor_account", source: "vision" };
  }

  // Single vision pass — reads the fields and judges whether it's a real receipt.
  const vision = await openaiService.extractReceiptFieldsFromImage(media || {});
  if (!vision) {
    // Model unreachable or didn't return usable JSON — treat as unreadable.
    return { ok: false, reason: "unreadable", source: "vision" };
  }

  const fields = {
    amount: toNumber(vision.amount),
    accountNumber: digits(vision.beneficiaryAccountNumber) || null,
    reference: cleanReference(vision.reference),
  };

  // Deterministic checks — only vision can positively say "not a receipt", and
  // it also flags an image that looks edited/forged as not a genuine receipt.
  if (vision.isReceipt === false) {
    return { ok: false, reason: "not_a_receipt", source: "vision", fields };
  }
  if (fields.amount == null || !digits(fields.accountNumber)) {
    return { ok: false, reason: "unreadable", source: "vision", fields };
  }
  if (digits(fields.accountNumber) !== digits(bankDetails.accountNumber)) {
    return { ok: false, reason: "account_mismatch", source: "vision", fields };
  }
  if (Math.round(fields.amount) !== Math.round(order.amount)) {
    return {
      ok: false,
      reason: "amount_mismatch",
      source: "vision",
      fields,
      expected: order.amount,
      got: fields.amount,
    };
  }

  return {
    ok: true,
    reason: "verified",
    source: "vision",
    reference: fields.reference || null,
    fields,
  };
}
