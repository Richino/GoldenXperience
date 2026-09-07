/**
 * Fetch EUR_USD M1 candles from OANDA (price=BA => bid/ask/mid) for the SAME
 * calendar window as the existing EUR_USD_M5.json, so M1 and M5 overlap exactly.
 *
 * Reuses the fetch pattern from api-server/scripts/_backtest_breakout_m5.ts.
 * Read-only market-data calls; does NOT touch the DB.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "api-server");
const envVars: Record<string, string> = {};
try {
  const txt = readFileSync(path.join(serviceRoot, ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) envVars[m[1]!] = m[2]!;
  }
} catch { /* ignore */ }
const env = (k: string) => (process.env[k] ?? envVars[k])?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, "candles");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// Match the M5 file window exactly.
const M5 = JSON.parse(readFileSync(path.join(HERE, "..", "..", "backtest-breakout-m5", "candles", "EUR_USD_M5.json"), "utf8")) as { from: string; to: string; bars: unknown[] };
const FROM = M5.from;
const TO = M5.to;
const INST = "EUR_USD";
const GRAN = "M1";
const STEP = 60_000;

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

async function fetchPage(fromIso: string): Promise<Q[]> {
  const url = `${HOST}/v3/instruments/${INST}/candles?price=BA&granularity=${GRAN}&count=5000&from=${encodeURIComponent(fromIso)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.ok) {
      const j = await r.json() as { candles?: Array<Record<string, never>> };
      return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
        const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
        const mid = (b: number, a: number) => (b + a) / 2;
        return {
          closeTime: new Date(Date.parse(x.time) + STEP).toISOString(),
          open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
          bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
          askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
        };
      });
    }
    console.log(`  FETCH ${r.status}, retry ${attempt + 1}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  return [];
}

const cache = path.join(CACHE_DIR, `${INST}_${GRAN}.json`);
if (existsSync(cache)) {
  const cached = JSON.parse(readFileSync(cache, "utf8")) as { from: string; to: string; bars: Q[] };
  if (cached.from === FROM && cached.to === TO) { console.log(`already cached: ${cached.bars.length} bars`); process.exit(0); }
}

console.log(`fetching ${INST} ${GRAN}: ${FROM} -> ${TO}`);
const out: Q[] = [];
let cursor = FROM;
const toMs = Date.parse(TO);
for (let page = 0; page < 400; page++) {
  const batch = await fetchPage(cursor);
  if (batch.length === 0) break;
  out.push(...batch);
  const lastMs = Date.parse(batch[batch.length - 1]!.closeTime);
  if (page % 10 === 0) console.log(`  page ${page}: ${out.length} bars, at ${batch[batch.length - 1]!.closeTime}`);
  if (lastMs >= toMs || batch.length < 5000) break;
  cursor = new Date(lastMs).toISOString();
}
writeFileSync(cache, JSON.stringify({ from: FROM, to: TO, bars: out }));
console.log(`DONE ${INST} ${GRAN}: ${out.length} bars -> ${cache}`);
console.log(`first ${out[0]?.closeTime}  last ${out[out.length - 1]?.closeTime}`);
