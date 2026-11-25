import { test } from "node:test";
import assert from "node:assert/strict";
import { finish, likelyTwin, mergeReadings, parseCards, parseDeal, toBase64 } from "../src/tag.js";

const blank = { found: true, price: null, regular_price: null, size: null, unit: null,
  unit_price: null, unit_price_qty: null, unit_price_unit: null, note: null, buy_qty: null,
  deal_kind: null, save_amount: null, percent_off: null, product: null, same_as: null };
const extra = { product: null, regular: null, deal: null };
const tag = (o) => ({ ...blank, ...o });

test("nothing found", () => {
  assert.deepEqual(finish(tag({ found: false })), { found: false });
  assert.deepEqual(finish(tag({ price: null, size: 750, unit: "mL" })), { found: false });
  assert.deepEqual(finish(null), { found: false });
});

test("liquor tag with no unit price", () => {
  assert.deepEqual(finish(tag({ price: 24.99, size: 1.75, unit: "L" })),
    { found: true, price: 24.99, size: 1.75, unit: "L", note: null, check: null, buy: null, ...extra });
});

test("unit price matches", () => {
  // $3.49 for 16 oz is 21.8 cents an ounce
  const r = finish(tag({ price: 3.49, size: 16, unit: "oz", unit_price: 0.218, unit_price_qty: 1, unit_price_unit: "oz" }));
  assert.equal(r.check, "ok");
});

test("unit price in another unit of the same kind", () => {
  // $5.99 for 2 lb is $2.995/lb, tag says 18.7 cents per oz
  const r = finish(tag({ price: 5.99, size: 2, unit: "lb", unit_price: 0.187, unit_price_unit: "oz" }));
  assert.equal(r.check, "ok");
});

test("misread size is flagged", () => {
  const r = finish(tag({ price: 3.49, size: 6, unit: "oz", unit_price: 0.218, unit_price_qty: 1, unit_price_unit: "oz" }));
  assert.equal(r.check, "mismatch");
});

test("unit price at the regular price during a sale is fine", () => {
  // sale $2.50, regular $3.49, tag's unit price is from the regular price
  const r = finish(tag({ price: 2.5, regular_price: 3.49, size: 16, unit: "oz", unit_price: 0.218, unit_price_unit: "oz" }));
  assert.equal(r.check, "ok");
});

test("per 100 ct", () => {
  const r = finish(tag({ price: 6.9, size: 200, unit: "ct", unit_price: 3.45, unit_price_qty: 100, unit_price_unit: "ct" }));
  assert.equal(r.check, "ok");
});

test("size worked out from the unit price", () => {
  // $12.99 at 43.3 cents per fl oz is about 30 fl oz
  const r = finish(tag({ price: 12.99, unit_price: 0.433, unit_price_unit: "fl oz" }));
  assert.deepEqual([r.size, r.unit, r.check], [30, "fl oz", "estimated"]);
});

test("different kinds aren't compared", () => {
  const r = finish(tag({ price: 4, size: 12, unit: "ct", unit_price: 0.25, unit_price_unit: "oz" }));
  assert.equal(r.check, null);
});

test("junk is cleaned", () => {
  const r = finish(tag({ price: 4.999, size: -1, unit: "pints", note: "  member price  " }));
  assert.deepEqual(r, { found: true, price: 5, size: null, unit: null, note: "member price", check: null, buy: null, ...extra });
});

test("buy one get one free", () => {
  // $8.99 BOGO for a 16 oz box: $4.50 each when you buy 2, tag says 28.1 cents per oz
  const r = finish(tag({ price: 4.495, regular_price: 8.99, size: 16, unit: "oz", unit_price: 0.281, unit_price_unit: "oz", buy_qty: 2 }));
  assert.deepEqual([r.price, r.check, r.buy], [4.5, "ok", 2]);
  assert.equal(finish(tag({ price: 3, buy_qty: 1 })).buy, null);
  assert.equal(finish(tag({ price: 3, buy_qty: 2.5 })).buy, null);
});

test("oz and fl oz check against each other", () => {
  // a drink tag that prints "22.42 cents per oz" read as 12 fl oz at $2.69
  const r = finish(tag({ price: 2.69, size: 12, unit: "fl oz", unit_price: 0.2242, unit_price_unit: "oz" }));
  assert.equal(r.check, "ok");
});

test("a sale sign with only a deal is kept", () => {
  const r = finish(tag({ deal_kind: "bogo", buy_qty: 2, note: "buy 1 get 1 free", product: "Publix ice cream" }));
  assert.deepEqual([r.found, r.price, r.deal, r.buy, r.product],
    [true, null, { kind: "free", paid: 1, free: 1 }, 2, "Publix ice cream"]);
  assert.equal(finish(tag({ deal_kind: "save", save_amount: 1.5 })).deal.save, 1.5);
  // a plain "25% off" sign waits for its tag too
  assert.equal(finish(tag({ deal_kind: "percent_off", percent_off: 25 })).found, true);
  // "sale" with no price to go on is nothing
  assert.deepEqual(finish(tag({ deal_kind: "sale" })), { found: false });
});

const shelf = finish(tag({ price: 5.99, size: 48, unit: "oz", unit_price: 0.125, unit_price_unit: "oz", product: "Publix ice cream 48 oz" }));

test("shelf tag then its BOGO sign", () => {
  const sign = finish(tag({ deal_kind: "bogo", buy_qty: 2, note: "buy 1 get 1 free" }));
  const m = mergeReadings(shelf, sign);
  assert.deepEqual([m.price, m.size, m.unit, m.buy, m.note, m.regular], [3, 48, "oz", 2, "buy 1 get 1 free", 5.99]);
  // either order
  assert.deepEqual(mergeReadings(sign, shelf), m);
});

test("save and percent-off signs", () => {
  assert.equal(mergeReadings(shelf, finish(tag({ deal_kind: "save", save_amount: 1 }))).price, 4.99);
  assert.equal(mergeReadings(shelf, finish(tag({ deal_kind: "percent_off", percent_off: 25 }))).price, 4.49);
});

test("a sale sign with its own price wins when it's lower", () => {
  const sign = finish(tag({ price: 4.49, deal_kind: "sale", note: "sale" }));
  const m = mergeReadings(shelf, sign);
  assert.deepEqual([m.price, m.size, m.note, m.check], [4.49, 48, "sale", null]);
});

test("the same tag twice is just the tag", () => {
  const m = mergeReadings(shelf, shelf);
  assert.deepEqual([m.price, m.size, m.check, m.buy], [5.99, 48, "ok", null]);
});

test("two deal-only signs give no price", () => {
  const sign = finish(tag({ deal_kind: "bogo" }));
  assert.equal(mergeReadings(sign, sign).price, null);
});

test("scanned items from the app are cleaned", () => {
  const cards = parseCards(JSON.stringify([
    { n: 3, product: "Tito's\nvodka", price: 24.99, size: 1.75, unit: "L", deal: { kind: "free", paid: 2, free: 1 } },
    { n: "x" }, { n: 4, size: 5, unit: "pints", check: "bad", deal: { kind: "free", paid: 99, free: 1 } }, 7,
  ]));
  assert.equal(cards.length, 2);
  assert.deepEqual([cards[0].product, cards[0].deal, cards[1].size, cards[1].check, cards[1].deal],
    ["Tito's vodka", { kind: "free", paid: 2, free: 1 }, null, null, null]);
  assert.deepEqual(parseCards("not json"), []);
  assert.deepEqual(parseCards(null), []);
});

test("the sign's words are worked out here", () => {
  const cases = {
    "Buy 2 Get One Free, Save 8.99 on 3": { kind: "free", paid: 2, free: 1 },
    "BUY 2 GET 1 FREE": { kind: "free", paid: 2, free: 1 },
    "Buy One Get One Free": { kind: "free", paid: 1, free: 1 },
    "BOGO": { kind: "free", paid: 1, free: 1 },
    "Buy 1 Get 1 50% Off": { kind: "pct", paid: 1, got: 1, pct: 50 },
    "2 for $5": { kind: "multi", n: 2, total: 5 },
    "3/$10": { kind: "multi", n: 3, total: 10 },
    "Save $1.50": { kind: "save", save: 1.5, n: 1 },
    "Save 8.99 on 3": { kind: "save", save: 3, n: 3 },
    "SAVE 8 99 ON 3": { kind: "save", save: 3, n: 3 },
    "25% off": { kind: "pct", paid: 0, got: 1, pct: 25 },
    "Sale ends 11/20": null,
    "Love to save here": null,
  };
  for (const [words, want] of Object.entries(cases)) assert.deepEqual(parseDeal(words), want, words);
});

// Thomas's Publix photos, 11/24: Coca-Cola Zero 6-pack $8.99, sign "Buy 2 Get One Free, Save 8.99 on 3"
const coke = finish(tag({ price: 8.99, size: 101.4, unit: "fl oz", unit_price: 0.0887, unit_price_unit: "fl oz", product: "Coca-Cola Zero 6-16.9 oz" }));

test("buy 2 get 1 free is $5.99 each, never 3 for $8.99", () => {
  // what the model said that night: price 3.00, "multi_buy", buy 3
  const misread = finish(tag({ price: 3, buy_qty: 3, deal_kind: "multi_buy", deal_text: "Buy 2 Get One Free, Save 8.99 on 3", size: 101.4, unit: "fl oz", product: "6-pack Coca-Cola soft drink 16.9 oz" }));
  assert.deepEqual([misread.price, misread.buy], [null, 3]);
  for (const m of [mergeReadings(coke, misread), mergeReadings(misread, coke)]) {
    assert.deepEqual([m.price, m.buy, m.size, m.regular], [5.99, 3, 101.4, 8.99]);
  }
  // with only the model's fields (no deal words), a "save 8.99 on 3" read as save 3.00 still gives 5.99
  const saveOnly = finish(tag({ deal_kind: "save", save_amount: 3, size: 101.4, unit: "fl oz" }));
  assert.equal(mergeReadings(coke, saveOnly).price, 5.99);
  // a price that's just the saving is dropped
  assert.equal(finish(tag({ price: 1.5, deal_text: "Save $1.50" })).price, null);
  // a printed sale price with its saving stays
  assert.equal(finish(tag({ price: 2.99, deal_text: "Save $1.00" })).price, 2.99);
});

test("2 for $5 on a sign is $2.50 each with or without the tag", () => {
  const sign = finish(tag({ price: 5, deal_text: "2 for $5" }));
  assert.deepEqual([sign.price, sign.buy], [2.5, 2]);
  assert.equal(mergeReadings(shelf, sign).price, 2.5);
});

test("backup match: a price-less sign and its tag", () => {
  const tagCard = { ...shelf, n: 1, product: "Publix premium ice cream vanilla 48 oz" };
  const breyers = { ...shelf, n: 2, price: 6.49, product: "Breyers natural vanilla ice cream 48 oz" };
  const bogo = finish(tag({ deal_kind: "bogo", size: 48, unit: "oz", product: "Publix Premium Ice Cream 48 oz" }));
  assert.equal(likelyTwin(bogo, [tagCard, breyers]), tagCard);
  // the other way round: the sign is already a card
  const signCard = { ...bogo, n: 3 };
  assert.equal(likelyTwin({ ...shelf, product: "Publix premium ice cream vanilla 48 oz" }, [signCard]), signCard);
  // another brand, another size, or two priced tags don't match
  assert.equal(likelyTwin(finish(tag({ deal_kind: "save", save_amount: 1.5, product: "Breyers Natural Vanilla" })), [tagCard]), null);
  assert.equal(likelyTwin(finish(tag({ deal_kind: "bogo", size: 16, unit: "oz", product: "Publix Premium Ice Cream" })), [tagCard]), null);
  assert.equal(likelyTwin({ ...shelf, product: "Publix premium ice cream vanilla" }, [tagCard]), null);
  // two cards that fit: don't guess
  assert.equal(likelyTwin(bogo, [tagCard, { ...tagCard, n: 4, product: "Publix premium ice cream chocolate 48 oz" }]), null);
  // a sign for a whole line: same brand first and the same printed size
  const cokeSign = finish(tag({ deal_text: "Buy 2 Get One Free", size: 101.4, unit: "fl oz", product: "Coca-Cola soft drink products 6-pack" }));
  const cokeCard = { ...coke, n: 5 };
  assert.equal(likelyTwin(cokeSign, [cokeCard]), cokeCard);
  // but not another brand that shares words ("ice cream")
  assert.equal(likelyTwin(finish(tag({ deal_text: "BOGO", size: 48, unit: "oz", product: "Publix Premium Ice Cream" })), [breyers]), null);
});

test("base64 matches Node's", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});
