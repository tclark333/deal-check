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

const OUNCES = new Set(["oz", "fl oz"]);

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

// Deals a sale sign can give without a price ("Buy 1 Get 1 Free", "Save $1.50", "25% off").
export const DEAL_KINDS = ["bogo", "multi_buy", "save", "percent_off", "sale"];

const text = (s, max) => (typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim().slice(0, max) : null);

/** The deal on a reading, or null. */
function cleanDeal(kind, save, pct) {
  if (!DEAL_KINDS.includes(kind)) return null;
  const p = positive(pct);
  return { kind, save: positive(save), pct: p && p < 100 ? p : null };
}

/**
 * Cleans the model's reading and cross-checks it against the tag's own unit price.
 * `check` is "ok" (it matches), "mismatch" (price or size is probably misread),
 * "estimated" (the size was worked out from the unit price) or null (nothing to check against).
 * `buy` is how many must be bought for that price (a "2 for $5" or buy-one-get-one deal), or null.
 * `price` can be null when the picture is a sale sign that gives only the deal; `deal` then says what
 * it is, so it can be put together with the item's regular shelf tag (see mergeReadings).
 */
export function finish(tag) {
  if (!tag || !tag.found) return { found: false };
  const deal = cleanDeal(tag.deal_kind, tag.save_amount, tag.percent_off);
  const rawPrice = positive(tag.price);
  // a sign with only a deal is useful once it meets its shelf tag; a bare "sale" with no price isn't
  if (!rawPrice && !(deal && (deal.kind === "bogo" || deal.save || deal.pct))) return { found: false };
  const price = rawPrice ? Math.round(rawPrice * 100) / 100 : null;
  const regular = positive(tag.regular_price);
  let size = positive(tag.size);
  let u = unit(tag.unit);
  if (!size || !u) {
    size = null;
    u = null;
  }
  let tagUnit = unit(tag.unit_price_unit);
  // Grocery tags print "OZ" on drinks too, so an ounce is an ounce either way.
  if (u && tagUnit && u !== tagUnit && OUNCES.has(u) && OUNCES.has(tagUnit)) tagUnit = u;
  const tagRate = perBase(positive(tag.unit_price), positive(tag.unit_price_qty) ?? 1, tagUnit);

  let check = null;
  if (tagRate && size && UNITS[u].kind === UNITS[tagUnit].kind && (price || regular)) {
    // Some stores print the unit price at the regular price even during a sale.
    const matches = [price, regular].some((p) => p && Math.abs(perBase(p, size, u) / tagRate - 1) <= TOLERANCE);
    check = matches ? "ok" : "mismatch";
  } else if (tagRate && !size && (price || regular)) {
    // No size on the tag, but the unit price gives it away: price / rate, in the unit price's unit.
    // A sale price's unit price may be printed at the regular price, so try the regular first.
    size = roundSize((regular ?? price) / tagRate / UNITS[tagUnit].base);
    u = tagUnit;
    check = "estimated";
  }

  // how many to buy for that price (multi-buy and buy-one-get-one deals)
  const buy = Number.isInteger(tag.buy_qty) && tag.buy_qty >= 2 && tag.buy_qty <= 12 ? tag.buy_qty : null;
  return {
    found: true, price, size, unit: u, note: text(tag.note, 80), check, buy,
    product: text(tag.product, 60), regular, deal,
  };
}

/**
 * One item from two pictures of it, such as its regular shelf tag and its sale sign (in either
 * order), or the same tag taken twice. The size comes from whichever has it; the price is the
 * lowest either one gives, working a price-less deal ("Buy 1 Get 1", "Save $1") out from the
 * regular price.
 */
export function mergeReadings(a, b) {
  const sized = a.size ? a : b.size ? b : null;
  // the regular price: printed as such, or a price that isn't a deal
  const regular = a.regular ?? b.regular ?? [a, b].find((x) => x.price && !x.deal)?.price ?? null;
  const options = [];
  for (const x of [a, b]) {
    if (x.price) options.push({ price: x.price, buy: x.buy, from: x });
    else if (x.deal && regular) {
      const { kind, save, pct } = x.deal;
      if (kind === "bogo" && !save && !pct) options.push({ price: regular / 2, buy: 2, from: x });
      else if (save) options.push({ price: regular - save, buy: x.buy, from: x });
      else if (pct) options.push({ price: regular * (1 - pct / 100), buy: x.buy, from: x });
    }
  }
  const best = options.filter((o) => o.price > 0).sort((p, q) => p.price - q.price)[0] ?? null;
  const dealer = [a, b].find((x) => x.deal) ?? null;
  let check = null;
  if (sized && (best?.from === sized || sized.check === "estimated")) check = sized.check;
  return {
    found: true,
    price: best ? Math.round(best.price * 100) / 100 : null,
    size: sized?.size ?? null,
    unit: sized?.unit ?? null,
    note: dealer?.note ?? a.note ?? b.note ?? null,
    check,
    buy: best?.buy ?? null,
    product: sized?.product ?? a.product ?? b.product ?? null,
    regular,
    deal: dealer?.deal ?? null,
  };
}

/** The items already scanned, as the app sends them (?cards=[...]): cleaned, at most four. */
export function parseCards(raw) {
  let list;
  try {
    list = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && Number.isInteger(c.n) && c.n > 0 && c.n < 1e6)
    .slice(0, 4)
    .map((c) => {
      const size = positive(c.size);
      const u = unit(c.unit);
      const d = c.deal && typeof c.deal === "object" ? cleanDeal(c.deal.kind, c.deal.save, c.deal.pct) : null;
      return {
        n: c.n,
        found: true,
        price: positive(c.price),
        size: size && u ? size : null,
        unit: size && u ? u : null,
        note: text(c.note, 80),
        check: ["ok", "mismatch", "estimated"].includes(c.check) ? c.check : null,
        buy: Number.isInteger(c.buy) && c.buy >= 2 && c.buy <= 12 ? c.buy : null,
        product: text(c.product, 60),
        regular: positive(c.regular),
        deal: d,
      };
    });
}

// Words that say nothing about which product it is.
const FILLER = new Set(["oz", "fl", "ml", "l", "lb", "lbs", "ct", "ounce", "ounces", "pack", "pk", "the", "and", "of", "with"]);

function nameWords(s) {
  return new Set((s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((w) => w && !/^\d/.test(w) && !FILLER.has(w)));
}

/** Same amount of product (an ounce is an ounce either way), or one side doesn't say. */
function sameSize(a, b) {
  if (!a.size || !b.size) return true;
  if (OUNCES.has(a.unit) && OUNCES.has(b.unit)) return Math.abs(a.size / b.size - 1) < 0.03;
  if (UNITS[a.unit].kind !== UNITS[b.unit].kind) return false;
  return Math.abs((a.size * UNITS[a.unit].base) / (b.size * UNITS[b.unit].base) - 1) < 0.03;
}

/**
 * The backup for when the model doesn't say a sale sign and a shelf tag are the same item: a sign
 * with only the deal meeting a priced tag (or the other way round) whose names agree (the shorter
 * name's words nearly all in the longer, since signs name things more briefly) and whose sizes
 * agree. Only when exactly one card fits.
 */
export function likelyTwin(own, cards) {
  const mine = nameWords(own.product);
  if (mine.size < 2) return null;
  const fits = cards.filter((c) => {
    if (!!c.price === !!own.price) return false; // one must be a price-less sign, the other priced
    if (!(c.deal && !c.price) && !(own.deal && !own.price)) return false;
    const theirs = nameWords(c.product);
    if (theirs.size < 2 || !sameSize(own, c)) return false;
    const [small, big] = mine.size <= theirs.size ? [mine, theirs] : [theirs, mine];
    return [...small].filter((w) => big.has(w)).length / small.size >= 0.75;
  });
  return fits.length === 1 ? fits[0] : null;
}

/** How an already-scanned item is described to the model, one line each. */
export function describeCard(c) {
  const parts = [c.product ?? "item (name not read)"];
  parts.push(c.size ? `${c.size} ${c.unit}` : "size not read");
  parts.push(c.price ? `$${c.price.toFixed(2)}` : "no price yet");
  if (c.note) parts.push(c.note);
  return `#${c.n}: ${parts.join(", ")}`;
}

/** Base64 of a byte array, without Node's Buffer. */
export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
