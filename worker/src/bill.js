// Pure helpers for turning what the model read off a restaurant bill into what Tip Check shows.
// Kept free of Worker and SDK imports so `npm test` can run them under plain Node.

// Bills round to the cent, and discounts or a missed line can throw the sum off; allow a little.
const SLACK = 0.06;

const money = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);
const text = (s, max) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);

/**
 * Cleans the model's reading of a bill.
 * Returns { found: false } when there's nothing usable, otherwise
 * { found, subtotal, total, included, includedKind, includedLabel, fees, feeLabel, suggested, check }:
 * - subtotal: food and drink before tax, fees and tip (the tip is worked out on this)
 * - total: what the bill says to pay before any extra tip (it already holds any included tip)
 * - included: dollars of gratuity or service charge already added, or null when there's none
 * - includedKind: "gratuity" or "service_charge" (a service charge may not go to the server)
 * - fees: other added charges that aren't a tip (kitchen fee, card surcharge), or null
 * - suggested: the bill prints suggested tip amounts (those are NOT included)
 * - check: "ok" when subtotal + tax + fees + included matches the total, "mismatch" when it's well off, null when it can't be checked
 */
export function finishBill(bill) {
  if (!bill || !bill.found) return { found: false };
  let subtotal = money(bill.subtotal);
  let total = money(bill.total_due);
  const tax = money(bill.tax) ?? 0;
  const included = money(bill.included_tip);
  const fees = money(bill.fees);
  const includedKind = included ? (bill.included_kind === "service_charge" ? "service_charge" : "gratuity") : null;

  // A total smaller than what's in it is a misread total; drop it rather than show a wrong number.
  if (total && subtotal && total + SLACK < subtotal) total = null;
  if (!subtotal && !total) return { found: false };

  let check = null;
  if (subtotal && total) {
    const sum = subtotal + tax + (fees ?? 0) + (included ?? 0);
    check = Math.abs(sum - total) <= Math.max(SLACK, total * 0.01) ? "ok" : "mismatch";
  }
  // Only a total: work out the food and drink when the rest of the bill is known.
  if (!subtotal && total && bill.tax != null) {
    const s = total - tax - (fees ?? 0) - (included ?? 0);
    if (s > 0) subtotal = Math.round(s * 100) / 100;
  }

  return {
    found: true,
    subtotal,
    total,
    included,
    includedKind,
    includedLabel: included ? text(bill.included_label, 40) : null,
    fees,
    feeLabel: fees ? text(bill.fee_label, 40) : null,
    suggested: !!bill.suggested_tips_printed && !included,
    check,
  };
}
