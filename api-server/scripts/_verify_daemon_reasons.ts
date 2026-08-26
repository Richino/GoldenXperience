/**
 * Independent verification of the legacy-confidence-v2 daemon's rejection
 * reasons. Fetches live OANDA M15/H1/H4 for the 12 pairs the daemon evaluated,
 * runs the same evaluateLegacySetup(), and cross-tabulates raw indicator values
 * against the daemon's reported reason. Also flags whether a newer M15 bar
 * has closed since the daemon ran.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { evaluateLegacySetup, atr, rsi } = await import("../src/legacy-setup-detector.js");
type LegacyCandle = Parameters<typeof evaluateLegacySetup>[1][number];

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };

async function fetchCandles(inst: string, gran: string, count: number): Promise<LegacyCandle[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=${count}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) return [];
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  const step = GRAN_MIN[gran]! * 60_000;
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    const mid = (b: number, a: number) => (b + a) / 2;
    return {
      closeTime: new Date(Date.parse(x.time) + step).toISOString(),
      open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return NaN;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

// The daemon reported these reasons at 2026-08-26T16:12:34.938Z on the 16:00 UTC M15 bar
const DAEMON_REPORTS: Record<string, string> = {
  USD_JPY: "Price did not pull into EMA21/50 zone",
  AUD_USD: "M15 EMA21/50/200 stack not aligned",
  EUR_USD: "H4 EMA21/50 opposes M15 direction",
  GBP_USD: "H4 EMA21/50 opposes M15 direction",
  USD_CAD: "H4 EMA21/50 opposes M15 direction",
  USD_CHF: "H4 EMA21/50 opposes M15 direction",
  EUR_JPY: "M15 EMA21/50/200 stack not aligned",
  GBP_JPY: "H4 EMA21/50 opposes M15 direction",
  AUD_JPY: "No 5-bar structural break in direction",
  EUR_GBP: "Price did not pull into EMA21/50 zone",
  NZD_USD: "H4 EMA21/50 opposes M15 direction",
  XAU_USD: "H1 EMA21/50 does not agree with M15 direction",
};

const PAIRS = Object.keys(DAEMON_REPORTS);

console.log(`\n=== INDEPENDENT VERIFICATION vs daemon @ 2026-08-26T16:12 UTC ===`);
console.log(`Host: ${HOST}\n`);

let agrees = 0, disagrees = 0;

for (const pair of PAIRS) {
  const [m15, h1, h4] = await Promise.all([
    fetchCandles(pair, "M15", 500),
    fetchCandles(pair, "H1", 300),
    fetchCandles(pair, "H4", 200),
  ]);
  if (m15.length < 210 || h1.length < 60 || h4.length < 60) {
    console.log(`${pair.padEnd(8)}  insufficient data`);
    continue;
  }
  const last = m15[m15.length - 1]!;
  const closes15 = m15.map((b) => b.close);
  const e21 = ema(closes15, 21);
  const e50 = ema(closes15, 50);
  const e200 = ema(closes15, 200);
  const bullish = e21 > e50 && e50 > e200;
  const bearish = e21 < e50 && e50 < e200;
  const dir = bullish ? "long" : bearish ? "short" : "mixed";
  const h1e21 = ema(h1.map((b) => b.close), 21);
  const h1e50 = ema(h1.map((b) => b.close), 50);
  const h4e21 = ema(h4.map((b) => b.close), 21);
  const h4e50 = ema(h4.map((b) => b.close), 50);
  const h1Bias = h1e21 > h1e50 ? "bullish" : h1e21 < h1e50 ? "bearish" : "flat";
  const h4Bias = h4e21 > h4e50 ? "bullish" : h4e21 < h4e50 ? "bearish" : "flat";

  const a14series = atr(m15, 14);
  const atrV = a14series[a14series.length - 1]!;
  const zoneLo = Math.min(e21, e50) - 0.35 * atrV;
  const zoneHi = Math.max(e21, e50) + 0.35 * atrV;
  const inZone = last.low <= zoneHi && last.high >= zoneLo;

  const win = m15.slice(-6, -1);
  const prevHi = Math.max(...win.map((b) => b.high));
  const prevLo = Math.min(...win.map((b) => b.low));
  const structBreakLong = last.close > prevHi;
  const structBreakShort = last.close < prevLo;

  const my = evaluateLegacySetup(pair, m15, h1, h4);
  const myReason = my.passed ? "PASSED" : (my.reason ?? "(none)");
  const daemonReason = DAEMON_REPORTS[pair]!;
  const match = myReason === daemonReason;
  if (match) agrees++; else disagrees++;

  const barAt = new Date(last.closeTime).toISOString();
  const newer = Date.parse(last.closeTime) > Date.parse("2026-08-26T16:00:00Z");
  console.log(
    `${pair.padEnd(8)} bar=${barAt.slice(11, 16)}Z${newer ? "*" : " "}  m15:${dir.padEnd(5)}  h1:${h1Bias.padEnd(7)}  h4:${h4Bias.padEnd(7)}  inZone=${inZone ? "Y" : "N"}  break: L=${structBreakLong ? "Y" : "N"} S=${structBreakShort ? "Y" : "N"}  ${match ? "✓" : "✗"}`,
  );
  console.log(
    `           EMA21=${e21.toFixed(5)}  EMA50=${e50.toFixed(5)}  EMA200=${e200.toFixed(5)}  last close=${last.close.toFixed(5)}  ATR14=${atrV.toFixed(5)}`,
  );
  console.log(
    `           H1: 21=${h1e21.toFixed(5)} 50=${h1e50.toFixed(5)}   H4: 21=${h4e21.toFixed(5)} 50=${h4e50.toFixed(5)}`,
  );
  if (!match) {
    console.log(`           daemon said : "${daemonReason}"`);
    console.log(`           now says    : "${myReason}"`);
  } else {
    console.log(`           reason      : "${myReason}"`);
  }
  console.log();
}

console.log(`\n=== SUMMARY ===`);
console.log(`  agrees:    ${agrees}/12`);
console.log(`  disagrees: ${disagrees}/12 (probably because a newer M15 bar has closed since the daemon ran — bars marked * are newer)`);

process.exit(0);
