// Deal Check's shelf-tag reader. The app posts a photo of a shelf tag; this sends it to Claude
// and answers with the price, size and unit to fill in. It exists so the Anthropic API key stays
// here (a Worker secret, ANTHROPIC_API_KEY) and never in the public page.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { UNIT_NAMES, finish, toBase64 } from "./tag.js";

// Only the app may call this. (localhost:8765 is for testing a local copy of the page.)
const ORIGINS = new Set(["https://tclark333.github.io", "http://localhost:8765"]);
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5_000_000; // the app sends ~300 KB; this just turns away junk
const DAILY_CAP = 300; // scans per day across everyone; a fraction of a cent each

const Unit = z.enum(UNIT_NAMES);
const Tag = z.object({
  found: z.boolean(),
  price: z.number().nullable(),
  regular_price: z.number().nullable(),
  size: z.number().nullable(),
  unit: Unit.nullable(),
  unit_price: z.number().nullable(),
  unit_price_qty: z.number().nullable(),
  unit_price_unit: Unit.nullable(),
  note: z.string().nullable(),
});

const SYSTEM = `You read store shelf tags (the price labels on shelves) from phone photos, for an app that works out which size of a product is the better deal. Report what someone pays to buy one of the item and how much product that gets them.

Fields:
- found: false if no shelf tag with a readable price is in the photo; then set every other field to null.
- price: dollars to buy one. If a sale, clearance, rollback or member/card price is shown, use that. For a multi-buy deal such as "2 for $5", give the price of one at the deal (2.50) and say so in note. Ignore deposits, CRV and bottle fees.
- regular_price: when price is a sale or deal price and the regular price is also shown, the regular price for one; otherwise null.
- size and unit: the total contents of one purchase. Liquor and wine tags usually print it as 50ML, 375ML, 750ML, 1L or 1.75L. For a multipack, multiply it out (a 6-pack of 12 fl oz cans is 72 fl oz). Use "fl oz" for liquids measured in ounces and "oz" for weight. Use "ct" for things sold by count (eggs, rolls, pods, bags, tablets) when the tag gives a count rather than a volume or weight.
- unit_price, unit_price_qty, unit_price_unit: the unit price printed on the tag, in dollars. "$0.25 per oz" is 0.25, 1, "oz". "12.3¢ / fl oz" is 0.123, 1, "fl oz". "$3.45 per 100 ct" is 3.45, 100, "ct". "$1.99/lb" is 1.99, 1, "lb". If the tag prints no unit price, all three are null.
- note: at most five words, only about the deal itself, such as "2 for $5 deal", "member price" or "sale ends 11/20"; otherwise null. Never comment on the photo or on how sure you are.

Never guess a number you can't read clearly: use null instead. If several tags are in the photo, use the one nearest the center.`;

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

/** Counts today's scans; false once the day's cap is reached. */
async function underDailyCap(env) {
  const key = "day:" + new Date().toISOString().slice(0, 10);
  const used = Number(await env.SCANS.get(key)) || 0;
  if (used >= DAILY_CAP) return false;
  await env.SCANS.put(key, String(used + 1), { expirationTtl: 3 * 86400 });
  return true;
}

async function readTag(env, mediaType, bytes) {
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
          { type: "text", text: "Read this shelf tag." },
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

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.SCAN_LIMIT.limit({ key: ip });
    if (!success) return reply({ error: "busy" }, 429, origin);
    if (!(await underDailyCap(env))) return reply({ error: "cap" }, 429, origin);

    if (!env.ANTHROPIC_API_KEY) {
      console.log("ANTHROPIC_API_KEY is not set");
      return reply({ error: "failed" }, 500, origin);
    }
    try {
      const tag = await readTag(env, mediaType, bytes);
      return tag ? reply(finish(tag), 200, origin) : reply({ error: "failed" }, 502, origin);
    } catch (err) {
      console.log("scan failed", err?.status ?? "", err?.message ?? String(err));
      return reply({ error: "failed" }, 502, origin);
    }
  },
};
