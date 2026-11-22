import { test } from "node:test";
import assert from "node:assert/strict";
import { finishBill } from "../src/bill.js";

const blank = { found: true, subtotal: null, tax: null, total_due: null, included_tip: null,
  included_kind: null, included_label: null, fees: null, fee_label: null, suggested_tips_printed: false };
const bill = (o) => ({ ...blank, ...o });

test("nothing found", () => {
  assert.deepEqual(finishBill(bill({ found: false })), { found: false });
  assert.deepEqual(finishBill(bill({})), { found: false });
  assert.deepEqual(finishBill(null), { found: false });
});

test("plain bill, no tip included", () => {
  const r = finishBill(bill({ subtotal: 62.4, tax: 5.15, total_due: 67.55 }));
  assert.deepEqual(r, { found: true, subtotal: 62.4, total: 67.55, included: null, includedKind: null,
    includedLabel: null, fees: null, feeLabel: null, suggested: false, check: "ok" });
});

test("gratuity included", () => {
  const r = finishBill(bill({ subtotal: 120, tax: 9.9, included_tip: 21.6, included_kind: "gratuity",
    included_label: "Gratuity 18%", total_due: 151.5 }));
  assert.deepEqual([r.included, r.includedKind, r.includedLabel, r.check], [21.6, "gratuity", "Gratuity 18%", "ok"]);
});

test("service charge is kept apart from gratuity", () => {
  const r = finishBill(bill({ subtotal: 50, tax: 4, included_tip: 10, included_kind: "service_charge", total_due: 64 }));
  assert.equal(r.includedKind, "service_charge");
});

test("suggested tips are not included", () => {
  const r = finishBill(bill({ subtotal: 40, tax: 3.3, total_due: 43.3, suggested_tips_printed: true }));
  assert.deepEqual([r.included, r.suggested], [null, true]);
  // and when a real gratuity is there, the suggestions don't matter
  const g = finishBill(bill({ subtotal: 40, included_tip: 8, total_due: 48, suggested_tips_printed: true }));
  assert.equal(g.suggested, false);
});

test("a fee is not a tip", () => {
  const r = finishBill(bill({ subtotal: 30, tax: 2.4, fees: 0.9, fee_label: "Kitchen fee 3%", total_due: 33.3 }));
  assert.deepEqual([r.included, r.fees, r.feeLabel, r.check], [null, 0.9, "Kitchen fee 3%", "ok"]);
});

test("numbers that don't add up are flagged", () => {
  const r = finishBill(bill({ subtotal: 62.4, tax: 5.15, total_due: 76.55 }));
  assert.equal(r.check, "mismatch");
});

test("only the total: food and drink worked out from it", () => {
  const r = finishBill(bill({ tax: 5.15, total_due: 67.55 }));
  assert.deepEqual([r.subtotal, r.total, r.check], [62.4, 67.55, null]);
  // without the tax there's nothing to work it out from
  assert.equal(finishBill(bill({ total_due: 67.55 })).subtotal, null);
});

test("a total smaller than the food is dropped", () => {
  const r = finishBill(bill({ subtotal: 62.4, tax: 5.15, total_due: 6.75 }));
  assert.deepEqual([r.total, r.check], [null, null]);
});

test("junk is cleaned", () => {
  const r = finishBill(bill({ subtotal: 20.004, total_due: -3, included_tip: 0, included_kind: "gratuity", fees: "x" }));
  assert.deepEqual([r.subtotal, r.total, r.included, r.includedKind, r.fees], [20, null, null, null, null]);
});
