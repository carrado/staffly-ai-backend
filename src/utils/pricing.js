/**
 * Tax math for product pricing — mirrors velte's `computePrice`
 * (velte/src/lib/product-price.ts) so the customer sees the same all-in number
 * the merchant configured.
 *
 * Velte semantics (NOT what the field names might suggest):
 *   - `taxIncluded === true` means tax IS charged and ADDED on top of the price
 *     (finalPrice = price + taxAmount). When false, there's no tax at all.
 *   - `taxType` is 'percentage' or 'fixed'.
 *   - `taxValue` is stored as the merchant typed it: a plain percent (e.g. 7.5)
 *     or, for 'fixed', a NAIRA amount. Unlike price/minimumPrice (kobo), tax is
 *     NOT stored in kobo — so it is used directly against the Naira price.
 *
 * `buildTaxConfig` normalises the raw doc into { applies, type, value }.
 * `computeTax` returns integer-Naira figures (prices are whole Naira here):
 *   { net, tax, gross, applied, type, value }   where net + tax === gross.
 *   - net   = price before tax
 *   - tax   = tax added
 *   - gross = all-in price the customer pays / sees
 */
export function computeTax(amount, tax) {
  const price = Math.max(Math.round(Number(amount) || 0), 0);
  const none = { net: price, tax: 0, gross: price, applied: false, type: null, value: 0 };

  if (!tax || !tax.applies || !(Number(tax.value) > 0)) return none;

  let taxAmount;
  if (tax.type === 'percentage') {
    taxAmount = Math.round(price * (tax.value / 100));
  } else if (tax.type === 'fixed') {
    taxAmount = Math.round(tax.value); // already in Naira
  } else {
    return none;
  }

  return { net: price, tax: taxAmount, gross: price + taxAmount, applied: true, type: tax.type, value: tax.value };
}

/**
 * Normalise a raw Mongo product's tax fields into the config `computeTax` wants.
 * Tax applies only when the merchant enabled it (`taxIncluded === true`) AND a
 * positive value with a known type is set — exactly velte's `hasTax` gate. The
 * value passes through untouched (percent or Naira); it is never in kobo.
 */
export function buildTaxConfig(rawProduct) {
  const type =
    rawProduct.taxType === 'percentage' || rawProduct.taxType === 'fixed'
      ? rawProduct.taxType
      : null;
  const value = Number(rawProduct.taxValue);

  if (rawProduct.taxIncluded !== true || !type || !Number.isFinite(value) || value <= 0) {
    return { applies: false, type: null, value: 0 };
  }
  return { applies: true, type, value };
}
