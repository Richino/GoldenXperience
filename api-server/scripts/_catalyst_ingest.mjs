/**
 * catalyst-direction-v1 — cross-asset intraday ingest. RESEARCH ONLY.
 *
 * The previous phase established that rate information could not help because
 * every available series (FRED policy rates, 2Y yields) updates DAILY at best,
 * while the decision bars are M15. A daily variable is literally constant across
 * ~96 decision bars, so it cannot discriminate between them.
 *
 * OANDA carries M15 CFDs on the instruments that reprice intraday, including
 * USB02Y_USD — a US 2-year bond contract. That is genuine intraday short-end
 * repricing, the thing that was structurally unobtainable before.
 *
 * IMPORTANT SIGN CONVENTION: USB02Y_USD and USB10Y_USD are BOND PRICE contracts.
 * Price up means yield DOWN. Every yield-direction feature derived from them is
 * sign-flipped downstream and labelled `yield*` rather than `price*` so the
 * convention cannot be silently lost.
 *
 * Writes CSV to disk. Touches neither the database nor production.
 */
import fs from "node:fs";
import path from "node:path";

let env = "";
for (const f of [".env", ".env.local"]) {
  const p = path.join("C:/Users/arche/Desktop/code/GoldenXperience/api-server", f);
  if (fs.existsSync(p)) env += "\n" + fs.readFileSync(p, "utf8");
}
const g = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const TOKEN = g("OANDA_API_KEY") || g("OANDA_API_TOKEN");
const HOST = g("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
if (!TOKEN) { console.error("no OANDA token"); process.exit(1); }

const INSTRUMENTS = ["USB02Y_USD", "USB10Y_USD", "XAU_USD", "SPX500_USD",
                     "DE30_EUR", "JP225_USD", "UK100_GBP", "WTICO_USD"];
const START = process.env.START ?? "2022-08-01T00:00:00Z";
const END = process.env.END ?? "2026-08-05T00:00:00Z";
const OUT = process.env.OUT ?? "cross-asset.csv";

async function fetchChunk(inst, from) {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=M&granularity=M15&count=5000&from=${encodeURIComponent(from)}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.ok) return (await r.json()).candles ?? [];
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
    throw new Error(`${inst} ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  throw new Error(`${inst} exhausted retries`);
}

const rows = [];
for (const inst of INSTRUMENTS) {
  let cursor = START; let n = 0; let guard = 0;
  while (guard++ < 60) {
    const candles = await fetchChunk(inst, cursor);
    const done = candles.filter((c) => c.complete);
    if (!done.length) break;
    for (const c of done) {
      if (c.time >= END) continue;
      rows.push(`${inst},${c.time},${c.mid.o},${c.mid.h},${c.mid.l},${c.mid.c}`);
      n += 1;
    }
    const last = done.at(-1).time;
    if (last >= END || done.length < 10) break;
    cursor = new Date(Date.parse(last) + 60_000).toISOString();
    await new Promise((s) => setTimeout(s, 120));
  }
  console.log(`${inst.padEnd(12)} ${n} M15 bars`);
}
fs.writeFileSync(OUT, "instrument,time,o,h,l,c\n" + rows.join("\n"));
console.log(`wrote ${rows.length} rows -> ${path.resolve(OUT)}`);
