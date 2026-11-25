// Deal Check's shelf-tag reader, and Tip Check's bill reader at /bill. The app posts a photo; this
// sends it to Claude and answers with what to fill in (a tag's price, size and unit, or a bill's
// totals and whether a tip is already on it). It exists so the Anthropic API key stays here (a
// Worker secret, ANTHROPIC_API_KEY) and never in the public pages.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEAL_KINDS, UNIT_NAMES, describeCard, finish, likelyTwin, mergeReadings, parseCards, toBase64 } from "./tag.js";
import { finishBill } from "./bill.js";

// Only the app may call this. (localhost:8765 is for testing a local copy of the page.)
const ORIGINS = new Set(["https://tclark333.github.io", "http://localhost:8765"]);
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5_000_000; // the app sends ~300 KB; this just turns away junk
const DAILY_CAP = 300; // scans per day across everyone; a fraction of a cent each
const BILL_DAILY_CAP = 100; // bill reads per day across everyone (counted apart from tags)

const Unit = z.enum(UNIT_NAMES);
const Tag = z.object({
  found: z.boolean(),
  price: z.number().nullable(),
  regular_price: z.number().nullable(),
  buy_qty: z.number().nullable(),
  size: z.number().nullable(),
  unit: Unit.nullable(),
  unit_price: z.number().nullable(),
  unit_price_qty: z.number().nullable(),
  unit_price_unit: Unit.nullable(),
  note: z.string().nullable(),
  deal_text: z.string().nullable(),
  deal_kind: z.enum(DEAL_KINDS).nullable(),
  save_amount: z.number().nullable(),
  percent_off: z.number().nullable(),
  product: z.string().nullable(),
  same_as: z.number().nullable(),
});

const SYSTEM = `You read store shelf tags (the price labels on shelves) and sale signs from phone photos, for an app that works out which size of a product is the better deal. Report what someone pays to buy one of the item and how much product that gets them.

Fields:
- found: false if the photo shows no shelf tag, sale sign or price sticker with a readable price or deal; then set every other field to null.
- price: dollars to buy one. null when the photo is a sale sign that gives only the deal ("Buy 1 Get 1 Free", "Buy 2 Get One Free", "Save $1.50", "Save 8.99 on 3", "25% off") and no price to pay. If a sale, clearance, rollback or member/card price is shown, use that. For a multi-buy deal such as "2 for $5", give the price of one at the deal (2.50). For buy one get one free (BOGO) with the price shown, give half the price of one. If a sale sign for the same item sits beside its shelf tag, the sale sign's deal is the price. A "save $X" or "save $X on N" amount is never the price, and "save $X on N" is not "N for $X". Ignore deposits, CRV and bottle fees.
- buy_qty: how many you must buy to get that price, for a multi-buy or buy-get deal ("2 for $5" and BOGO are 2, "3 for $10" and "buy 2 get 1 free" are 3); otherwise null.
- regular_price: when price is a sale or deal price and the regular price is also shown, the regular price for one; otherwise null.
- size and unit: the total contents of one purchase. Liquor and wine tags usually print it as 50ML, 375ML, 750ML, 1L or 1.75L. For a multipack, multiply it out (a 6-pack of 12 fl oz cans is 72 fl oz). Use "fl oz" for liquids measured in ounces and "oz" for weight. Use "ct" for things sold by count (eggs, rolls, pods, bags, tablets) when the tag gives a count rather than a volume or weight.
- unit_price, unit_price_qty, unit_price_unit: the unit price printed on the tag, in dollars. "$0.25 per oz" is 0.25, 1, "oz". "12.3¢ / fl oz" is 0.123, 1, "fl oz". "$3.45 per 100 ct" is 3.45, 100, "ct". "$1.99/lb" is 1.99, 1, "lb". If the tag prints no unit price, all three are null.
- deal_text: the deal's words exactly as printed, joined with commas, such as "Buy 2 Get One Free, Save 8.99 on 3", "2 for $5", "BOGO" or "Save $1.50"; a price printed with small raised cents (8 with 99 above it) is written 8.99. Leave out slogans and fine print. null if there is no deal.
- deal_kind: "bogo" for buy one get one free (and any "buy N get M free"), "multi_buy" for deals like "2 for $5", "save" for a dollars-off amount, "percent_off" for a percent off, "sale" for a sale, clearance, rollback or member price; otherwise null.
- save_amount: dollars off one item when the sign says "Save $X" (for "Save $2 on 2", 1.00; for "Save 8.99 on 3", 3.00); otherwise null.
- percent_off: the percent off one item ("25% off" is 25; "buy 1 get 1 50% off" is 25 with buy_qty 2); otherwise null.
- product: what the item is, at most six words, such as "Tropicana orange juice 52 oz" or "Tito's vodka 1.75 L"; null if no name is printed.
- same_as: the message may list items already scanned for this comparison, each with a number. If this photo is of the same product as one of them (that product's sale sign, its regular shelf tag, or the same tag again), give that item's number. A sale sign usually names the product more briefly than its shelf tag (often leaving out the flavor) and often covers a whole line ("6-pack Coca-Cola soft drink products, 16.9-oz bot." covers a Coca-Cola Zero 6-pack of 16.9 oz bottles), so it covers every flavor and kind it names, so if the brand and product agree and the size matches or isn't on the sign, it's the same product. A different size or brand is a different product, and so is a shelf tag with a different flavor or scent from another shelf tag. Otherwise null.
- note: at most five words, only about the deal itself, such as "2 for $5 deal", "buy 1 get 1 free", "member price" or "sale ends 11/20"; otherwise null. Never comment on the photo or on how sure you are.

Never guess a number you can't read clearly: use null instead. If several tags are in the photo, use the one nearest the center.`;

const Bill = z.object({
  found: z.boolean(),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  fees: z.number().nullable(),
  fee_label: z.string().nullable(),
  included_tip: z.number().nullable(),
  included_kind: z.enum(["gratuity", "service_charge"]).nullable(),
  included_label: z.string().nullable(),
  total_due: z.number().nullable(),
  suggested_tips_printed: z.boolean(),
});

const BILL_SYSTEM = `You read restaurant bills (the check or receipt) from phone photos, for an app that tells an older diner whether the tip is already included and, if not, works out a tip. Getting "already included" wrong costs someone money or embarrasses them, so be careful and exact.

Fields:
- found: false if no restaurant bill with readable amounts is in the photo, or it is too blurry to read the totals with confidence; then set every number to null and suggested_tips_printed to false.
- subtotal: the food and drink total before tax, fees and any gratuity, after any discounts or coupons. Usually labeled Subtotal, Sub Total, Food & Bev, or Net.
- tax: the sales tax in dollars (add several tax lines together), or null if none is shown.
- fees: added charges that are NOT a tip and NOT a service charge, such as a kitchen appreciation fee, credit card surcharge, health or wellness fee, or delivery fee; add several together. null if none.
- fee_label: those fees' wording as printed, at most five words, such as "Kitchen fee 3%"; otherwise null.
- included_tip: dollars of tip that the restaurant has ALREADY ADDED to what is owed: lines such as Gratuity, Auto Gratuity, Auto Grat, Grat, Tip Included, Service Charge, or "18% gratuity added for parties of 6 or more" when the amount is actually on the bill. null if none. NOT included: a printed table of suggested tips ("Suggested gratuity: 18% = $9.12, 20% = $10.13"), a blank "Tip: ____" line, or a sentence saying gratuity may be added without a dollar amount on the bill.
- included_kind: "gratuity" for gratuity or tip wording, "service_charge" when it is labeled a service charge; null when included_tip is null.
- included_label: that line's wording as printed, at most five words, such as "Gratuity 18%"; otherwise null.
- total_due: the amount the bill says to pay before any extra tip. It already contains any included tip and fees. Use the bill's Total, Amount Due or Balance Due. If a tip has been handwritten or printed in on a signed card slip, still give the total before that tip. null if no total is shown.
- suggested_tips_printed: true if the bill prints suggested tip amounts or percentages for the diner to choose from.

Never guess a number you can't read clearly: use null instead. If several bills or slips are in the photo, use the itemized bill.`;

async function readBill(env, mediaType, bytes) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
  const message = await client.messages.parse({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Bill) },
    system: BILL_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: toBase64(bytes) } },
          { type: "text", text: "Read this restaurant bill." },
        ],
      },
    ],
  });
  if (message.stop_reason !== "end_turn" || !message.parsed_output) {
    console.log("unusable bill reply", message.stop_reason, JSON.stringify(message.stop_details ?? null));
    return null;
  }
  console.log("bill", JSON.stringify(message.parsed_output), JSON.stringify(message.usage));
  return message.parsed_output;
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Cache-Control": "no-store",
    },
  });
}

/** Counts today's scans (tags, or bills apart); false once the day's cap is reached. */
async function underDailyCap(env, isBill) {
  const key = (isBill ? "bill:" : "day:") + new Date().toISOString().slice(0, 10);
  const used = Number(await env.SCANS.get(key)) || 0;
  if (used >= (isBill ? BILL_DAILY_CAP : DAILY_CAP)) return false;
  await env.SCANS.put(key, String(used + 1), { expirationTtl: 3 * 86400 });
  return true;
}

async function readTag(env, mediaType, bytes, cards) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
  const message = await client.messages.parse({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Tag) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: toBase64(bytes) } },
          { type: "text", text: tagAsk(cards) },
        ],
      },
    ],
  });
  if (message.stop_reason !== "end_turn" || !message.parsed_output) {
    console.log("unusable reply", message.stop_reason, JSON.stringify(message.stop_details ?? null));
    return null;
  }
  console.log("read", JSON.stringify(message.parsed_output), JSON.stringify(message.usage));
  return message.parsed_output;
}

function tagAsk(cards) {
  if (!cards.length) return "Read this shelf tag.";
  return `Read this shelf tag or sale sign.\n\nItems already scanned:\n${cards.map(describeCard).join("\n")}`;
}

/**
 * The reading to send back. When the photo is the same product as an item already scanned, the
 * two are put together (`same` is that item's number) and `own` is this photo's reading alone,
 * for when the app no longer has that item. An app from before 11/23 (it sends no ?cards=) can't
 * show a sale sign without a price, so it gets "not found" for one, as it used to.
 */
function answer(tag, cards, newApp) {
  const own = finish(tag);
  if (!own.found) return own;
  if (!newApp && !own.price) return { found: false };
  const card = (Number.isInteger(tag.same_as) && cards.find((c) => c.n === tag.same_as)) || likelyTwin(own, cards);
  if (!card) return own;
  return { ...mergeReadings(card, own), same: card.n, own };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    if (!ORIGINS.has(origin)) return new Response("Forbidden", { status: 403 });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }
    if (request.method !== "POST") return reply({ error: "method" }, 405, origin);

    const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim();
    if (!TYPES.has(mediaType)) return reply({ error: "type" }, 415, origin);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return reply({ error: "size" }, 413, origin);

    const isBill = new URL(request.url).pathname === "/bill";
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.SCAN_LIMIT.limit({ key: ip });
    if (!success) return reply({ error: "busy" }, 429, origin);
    if (!(await underDailyCap(env, isBill))) return reply({ error: "cap" }, 429, origin);

    if (!env.ANTHROPIC_API_KEY) {
      console.log("ANTHROPIC_API_KEY is not set");
      return reply({ error: "failed" }, 500, origin);
    }
    try {
      if (isBill) {
        const bill = await readBill(env, mediaType, bytes);
        return bill ? reply(finishBill(bill), 200, origin) : reply({ error: "failed" }, 502, origin);
      }
      const params = new URL(request.url).searchParams;
      const cards = parseCards(params.get("cards"));
      const tag = await readTag(env, mediaType, bytes, cards);
      return tag ? reply(answer(tag, cards, params.has("cards")), 200, origin) : reply({ error: "failed" }, 502, origin);
    } catch (err) {
      console.log("scan failed", err?.status ?? "", err?.message ?? String(err));
      return reply({ error: "failed" }, 502, origin);
    }
  },
};
