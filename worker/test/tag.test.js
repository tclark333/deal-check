import { test } from "node:test";
import assert from "node:assert/strict";
import { finish, mergeReadings, parseCards, toBase64 } from "../src/tag.js";

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
  assert.deepEqual([r.found, r.price, r.deal.kind, r.product], [true, null, "bogo", "Publix ice cream"]);
  assert.equal(finish(tag({ deal_kind: "save", save_amount: 1.5 })).deal.save, 1.5);
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
    { n: 3, product: "Tito's\nvodka", price: 24.99, size: 1.75, unit: "L", deal: { kind: "bogo" } },
    { n: "x" }, { n: 4, size: 5, unit: "pints", check: "bad" }, 7,
  ]));
  assert.equal(cards.length, 2);
  assert.deepEqual([cards[0].product, cards[0].deal.kind, cards[1].size, cards[1].check], ["Tito's vodka", "bogo", null, null]);
  assert.deepEqual(parseCards("not json"), []);
  assert.deepEqual(parseCards(null), []);
});

test("base64 matches Node's", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});
