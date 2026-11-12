// Pure helpers for turning what the model read off a shelf tag into what the app fills in.
// Kept free of Worker and SDK imports so `npm test` can run them under plain Node.

// Same units as the app (index.html), each as a multiple of its kind's base unit.
export const UNITS = {
  mL: { kind: "volume", base: 1 },
  L: { kind: "volume", base: 1000 },
  "fl oz": { kind: "volume", base: 29.5735 },
  gal: { kind: "volume", base: 3785.41 },
  g: { kind: "weight", base: 1 },
  kg: { kind: "weight", base: 1000 },
  oz: { kind: "weight", base: 28.3495 },
  lb: { kind: "weight", base: 453.592 },
  ct: { kind: "count", base: 1 },
};
export const UNIT_NAMES = Object.keys(UNITS);

// Tags round their unit price (often to a tenth of a cent), so allow some slack.
const TOLERANCE = 0.06;

const positive = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
const unit = (u) => (UNIT_NAMES.includes(u) ? u : null);

/** Dollars per base unit for an amount of `qty` `u`, or null. */
function perBase(price, qty, u) {
  return price && qty && u ? price / (qty * UNITS[u].base) : null;
}

/** A worked-out size, rounded the way a tag would print it. */
function roundSize(n) {
  return n >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
}

/**
 * Cleans the model's reading and cross-checks it against the tag's own unit price.
 * `check` is "ok" (it matches), "mismatch" (price or size is probably misread),
 * "estimated" (the size was worked out from the unit price) or null (nothing to check against).
 */
export function finish(tag) {
  if (!tag || !tag.found || !positive(tag.price)) {
    return { found: false };
  }
  const price = Math.round(tag.price * 100) / 100;
  const regular = positive(tag.regular_price);
  let size = positive(tag.size);
  let u = unit(tag.unit);
  if (!size || !u) {
    size = null;
    u = null;
  }
  const tagRate = perBase(positive(tag.unit_price), positive(tag.unit_price_qty) ?? 1, unit(tag.unit_price_unit));
  const tagUnit = unit(tag.unit_price_unit);

  let check = null;
  if (tagRate && size && UNITS[u].kind === UNITS[tagUnit].kind) {
    // Some stores print the unit price at the regular price even during a sale.
    const matches = [price, regular].some((p) => p && Math.abs(perBase(p, size, u) / tagRate - 1) <= TOLERANCE);
    check = matches ? "ok" : "mismatch";
  } else if (tagRate && !size) {
    // No size on the tag, but the unit price gives it away: price / rate, in the unit price's unit.
    size = roundSize(price / tagRate / UNITS[tagUnit].base);
    u = tagUnit;
    check = "estimated";
  }

  const note = typeof tag.note === "string" && tag.note.trim() ? tag.note.trim().slice(0, 80) : null;
  return { found: true, price, size, unit: u, note, check };
}

/** Base64 of a byte array, without Node's Buffer. */
export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
