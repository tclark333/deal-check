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

// What the model may call a deal (its fallback when the sign's words can't be worked out here).
export const DEAL_KINDS = ["bogo", "multi_buy", "save", "percent_off", "sale"];

const text = (s, max) => (typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim().slice(0, max) : null);
const count = (n, min) => (Number.isInteger(n) && n >= min && n <= 12 ? n : null);
const cents = (n) => Math.round(n * 100) / 100;

/**
 * A deal, checked. Shapes: { kind: "free", paid, free } (buy 2 get 1 free is paid 2, free 1);
 * { kind: "pct", paid, got, pct } (25% off is paid 0, got 1; buy 1 get 1 50% off is paid 1, got 1);
 * { kind: "save", save, n } (dollars off each, n = how many to buy for it);
 * { kind: "multi", n, total } (2 for $5); { kind: "sale" } (a sale price, nothing to work out).
 */
function cleanDeal(d) {
  if (!d || typeof d !== "object") return null;
  switch (d.kind) {
    case "free": {
      const paid = count(d.paid, 1);
      const free = count(d.free, 1);
      return paid && free ? { kind: "free", paid, free } : null;
    }
    case "pct": {
      const paid = count(d.paid, 0);
      const got = count(d.got, 1);
      const pct = positive(d.pct);
      return paid !== null && got && pct && pct < 100 ? { kind: "pct", paid, got, pct } : null;
    }
    case "save": {
      const save = positive(d.save);
      return save ? { kind: "save", save: cents(save), n: count(d.n, 1) ?? 1 } : null;
    }
    case "multi": {
      const n = count(d.n, 2);
      const total = positive(d.total);
      return n && total ? { kind: "multi", n, total } : null;
    }
    case "sale":
      return { kind: "sale" };
  }
  return null;
}

const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const howMany = (s) => (s == null ? 1 : WORD_NUMBERS[s] ?? parseInt(s, 10));
const N = "(\\d+|an?|one|two|three|four|five|six)";
// "$8.99", "8.99", "8 99" (big dollars, small cents) or "$5"
const MONEY = "\\$?\\s*(\\d+)(?:[.\\s](\\d{2}))?";
const money = (d, c) => +d + (c ? +c / 100 : 0);

/**
 * Works out a deal from the sign's own words, as the model copied them: "Buy 2 Get One Free",
 * "BOGO", "Buy 1 Get 1 50% Off", "2 for $5", "Save $8.99 on 3", "25% off". Null if none of those.
 * Done here rather than by the model, which once read "Save 8.99 on 3" as "3 for $8.99".
 */
export function parseDeal(words) {
  if (typeof words !== "string") return null;
  const t = words.toLowerCase().replace(/[\u2010-\u2015]/g, "-");
  let m;
  if ((m = t.match(new RegExp(`buy\\s*${N}\\s*[,-]?\\s*get\\s*${N}?\\s*(?:(\\d+)\\s*%\\s*off|free)`)))) {
    const paid = howMany(m[1]);
    const got = howMany(m[2]);
    return cleanDeal(m[3] ? { kind: "pct", paid, got, pct: +m[3] } : { kind: "free", paid, free: got });
  }
  if (/\bbogo\b/.test(t)) {
    m = t.match(/(\d+)\s*%\s*off/);
    return cleanDeal(m ? { kind: "pct", paid: 1, got: 1, pct: +m[1] } : { kind: "free", paid: 1, free: 1 });
  }
  // "2 for $5", "2/$5" (a slash needs the $, so a date like 11/20 isn't a deal)
  if ((m = t.match(new RegExp(`(\\d+)\\s*(?:for\\s*|/\\s*(?=\\$))${MONEY}`)))) {
    return cleanDeal({ kind: "multi", n: +m[1], total: money(m[2], m[3]) });
  }
  if ((m = t.match(new RegExp(`save\\s*${MONEY}(?:\\s*(?:on|when you buy|with)\\s*${N})?`)))) {
    const n = howMany(m[3]);
    return cleanDeal({ kind: "save", save: money(m[1], m[2]) / n, n });
  }
  if ((m = t.match(/(\d+)\s*%\s*off/))) return cleanDeal({ kind: "pct", paid: 0, got: 1, pct: +m[1] });
  return null;
}

/** The model's own deal fields, for when the sign's words can't be worked out. */
function modelDeal(tag) {
  switch (tag.deal_kind) {
    case "bogo":
      return cleanDeal({ kind: "free", paid: 1, free: 1 });
    case "save":
      return cleanDeal({ kind: "save", save: tag.save_amount, n: 1 });
    case "percent_off":
      return cleanDeal({ kind: "pct", paid: 0, got: 1, pct: tag.percent_off });
    case "multi_buy":
      return positive(tag.price) && count(tag.buy_qty, 2)
        ? cleanDeal({ kind: "multi", n: tag.buy_qty, total: tag.price * tag.buy_qty })
        : null;
    case "sale":
      return { kind: "sale" };
  }
  return null;
}

/** What one costs at a deal, and how many to buy, given the regular price where it needs one. */
export function dealPrice(d, regular) {
  if (!d) return null;
  if (d.kind === "multi") return { price: d.total / d.n, buy: d.n };
  if (!regular) return null;
  if (d.kind === "free") return { price: (regular * d.paid) / (d.paid + d.free), buy: d.paid + d.free };
  if (d.kind === "pct") {
    const n = d.paid + d.got;
    return { price: (regular * (d.paid + d.got * (1 - d.pct / 100))) / n, buy: n > 1 ? n : null };
  }
  if (d.kind === "save" && d.save < regular) return { price: regular - d.save, buy: d.n > 1 ? d.n : null };
  return null;
}

/** A deal that gives a price only once the regular price is known (from the item's shelf tag). */
const needsRegular = (d) => d && (d.kind === "free" || d.kind === "save" || d.kind === "pct");

/**
 * Cleans the model's reading and cross-checks it against the tag's own unit price.
 * `check` is "ok" (it matches), "mismatch" (price or size is probably misread),
 * "estimated" (the size was worked out from the unit price) or null (nothing to check against).
 * `buy` is how many must be bought for that price (a "2 for $5" or buy-one-get-one deal), or null.
 * A deal is worked out here from the sign's words. `price` is null when the picture is a sale sign
 * whose deal needs the regular price; it is then put together with the item's shelf tag
 * (see mergeReadings).
 */
export function finish(tag) {
  if (!tag || !tag.found) return { found: false };
  const deal = parseDeal(tag.deal_text) ?? modelDeal(tag);
  const regular = positive(tag.regular_price);
  let price = positive(tag.price);
  let buy = count(tag.buy_qty, 2);
  const worked = dealPrice(deal, regular);
  if (worked) {
    price = worked.price;
    buy = worked.buy;
  } else if (needsRegular(deal)) {
    // A buy-get deal's price is never printed, so the model's own arithmetic is dropped; wait for
    // the tag. A "save" whose price is just the saving was misread. A printed sale price stays.
    const misread = deal.kind === "free" || (deal.kind === "pct" && deal.paid > 0)
      || (deal.kind === "save" && price && Math.abs(price - deal.save) < 0.015);
    if (misread) price = null;
    if (deal.kind === "free") buy = deal.paid + deal.free;
  }
  if (!price && !needsRegular(deal)) return { found: false };
  if (price) price = cents(price);
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

  return {
    found: true, price, size, unit: u, note: text(tag.note, 80), check, buy,
    product: text(tag.product, 60), regular, deal,
  };
}

/**
 * One item from two pictures of it, such as its regular shelf tag and its sale sign (in either
 * order), or the same tag taken twice. The size comes from whichever has it; the price is the
 * lowest either one gives, a deal being worked out from the regular price (never taken from the
 * model's own arithmetic when it can be worked out).
 */
export function mergeReadings(a, b) {
  const sized = a.size ? a : b.size ? b : null;
  // the regular price: printed as such, or a price that isn't a deal
  const regular = a.regular ?? b.regular ?? [a, b].find((x) => x.price && !x.deal)?.price ?? null;
  const options = [];
  for (const x of [a, b]) {
    const worked = dealPrice(x.deal, regular);
    if (worked) options.push({ ...worked, from: x });
    else if (x.price) options.push({ price: x.price, buy: x.buy, from: x });
  }
  const best = options.filter((o) => o.price > 0).sort((p, q) => p.price - q.price)[0] ?? null;
  const dealer = [a, b].find((x) => x.deal) ?? null;
  let check = null;
  if (sized && (best?.from === sized || sized.check === "estimated")) check = sized.check;
  return {
    found: true,
    price: best ? cents(best.price) : null,
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
      const d = cleanDeal(c.deal);
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
 * name's words nearly all in the longer, since signs name things more briefly, or the same brand
 * and both sizes printed and equal) and whose sizes agree. Only when exactly one card fits.
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
    const shared = [...small].filter((w) => big.has(w)).length;
    if (shared / small.size >= 0.75) return true;
    // a sign often names a whole line ("Coca-Cola soft drink products" for a Coca-Cola Zero tag):
    // the same brand first and the same size, both printed
    return shared >= 2 && [...mine][0] === [...theirs][0] && own.size && c.size;
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
