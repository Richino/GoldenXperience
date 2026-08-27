/**
 * M5 breakout scalper backtest.
 *
 * Adapts the breakout gates (consolidation-then-break with ATR threshold) to
 * M5 candles, targeting 5-10x the fire rate of the M15 breakout family.
 *
 * Recipe (in order):
 *   1) 20-bar M5 consolidation range with width in [1.0, 8.0] * ATR14 (M5)
 *   2) Close beyond level by >= 0.5 * ATR14 (M5) — bullish close for long, bearish for short
 *   3) Not chasing: close <= 3 * ATR14 past the level
 *   4) H1 EMA21 vs EMA50 must agree with direction (loose HTF check)
 *   5) Session gate: London (03-08 ET) or NY (08-17 ET)
 *   6) ATR14 (M5) >= 0.8 pips (volatility floor scaled down for M5)
 *   7) Spread <= spreadCap
 *   8) Stop = 0.5 * ATR14 below level for long (opposite for short)
 *   9) Target = 2 * stop distance (2R)
 *
 * RESEARCH ONLY. Uses labelOutcome resolver.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { labelOutcome } = await import("../src/research.js");

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const OUT_DIR = path.join(serviceRoot, "..", "backtest-breakout-m5");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const CACHE_DIR = path.join(OUT_DIR, "candles");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, "trades.json");

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const YEARS_BACK = 3;
const TARGET_TRADES = 30000;

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

const GRAN_MIN: Record<string, number> = { M5: 5, H1: 60 };

async function fetchPage(inst: string, gran: string, fromIso: string): Promise<Q[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=5000&from=${encodeURIComponent(fromIso)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`  FETCH FAIL ${inst} ${gran} ${r.status}`); return []; }
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

async function fetchAll(inst: string, gran: string, fromIso: string, toIso: string): Promise<Q[]> {
  const cache = path.join(CACHE_DIR, `${inst}_${gran}.json`);
  if (existsSync(cache)) {
    const cached = JSON.parse(readFileSync(cache, "utf8")) as { from: string; to: string; bars: Q[] };
    if (cached.from === fromIso && cached.to === toIso) { console.log(`  ${inst} ${gran}: ${cached.bars.length} bars (cached)`); return cached.bars; }
  }
  const out: Q[] = [];
  let cursor = fromIso;
  const toMs = Date.parse(toIso);
  for (let page = 0; page < 150; page++) {
    const batch = await fetchPage(inst, gran, cursor);
    if (batch.length === 0) break;
    out.push(...batch);
    const lastMs = Date.parse(batch[batch.length - 1]!.closeTime);
    if (lastMs >= toMs || batch.length < 5000) break;
    cursor = new Date(lastMs + 60_000).toISOString();
  }
  writeFileSync(cache, JSON.stringify({ from: fromIso, to: toIso, bars: out }));
  console.log(`  ${inst} ${gran}: ${out.length} bars fetched`);
  return out;
}

function ema(values: number[], period: number): number[] {
  const out: number[] = []; if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0]!; out.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}
function atr(bars: Q[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const trs: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { trs[i] = b.high - b.low; continue; }
    const p = bars[i - 1]!;
    trs[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period;
    out[period - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]!) / period; out[i] = a; }
  }
  return out;
}
function pipSize(inst: string): number {
  return inst.endsWith("JPY") ? 0.01 : 0.0001;
}
function spreadCap(inst: string): number {
  return inst.includes("JPY") ? 3 : 2;
}
function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function inSession(iso: string): boolean {
  const h = etHour(iso);
  return h >= 3 && h < 17; // London (03-08) + London/NY overlap (08-12) + NY (12-17)
}
function htfBias(closeTime: string, bars: Q[], e21: number[], e50: number[]): -1 | 0 | 1 {
  const t = Date.parse(closeTime);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return 0;
  const a = e21[k]; const b = e50[k];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return a > b ? 1 : -1;
}

// ---- run ----
const now = new Date();
const fromIso = new Date(now.getTime() - YEARS_BACK * 365 * 86400e3).toISOString();
const toIso = now.toISOString();
console.log(`fetching ${YEARS_BACK}y M5/H1 for ${PAIRS.length} pairs (${fromIso} → ${toIso})`);

type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number;
  stopPips: number; targetPips: number; spreadPips: number;
  atrPips: number; rangeWidthAtr: number; sessionHourEt: number;
  outcome: string; resultR: number | null; resolvedAt: string | null;
};
const trades: Trade[] = [];

const LOOKBACK = 20;
const BREAK_THRESHOLD = 0.5; // ATR multiples
const MIN_RANGE_ATR = 1.0;
const MAX_RANGE_ATR = 8.0;
const MAX_EXTENSION_ATR = 3.0;
const STOP_ATR = 0.5;
const TARGET_R = 2.0;
const MIN_ATR_PIPS = 0.8;

for (const pair of PAIRS) {
  console.log(`\n--- ${pair} ---`);
  const m5 = await fetchAll(pair, "M5", fromIso, toIso);
  const h1 = await fetchAll(pair, "H1", fromIso, toIso);
  if (m5.length < 300) { console.log(`  too few M5 bars, skip`); continue; }

  const closes5 = m5.map((b) => b.close);
  const a14 = atr(m5, 14);
  const h1_e21 = ema(h1.map((b) => b.close), 21);
  const h1_e50 = ema(h1.map((b) => b.close), 50);
  const pip = pipSize(pair);
  const spMax = spreadCap(pair);

  let openUntilMs = 0;
  let taken = 0;

  for (let i = 30; i < m5.length - 1; i++) {
    const bar = m5[i]!;
    const t = Date.parse(bar.closeTime);
    if (t < openUntilMs) continue;
    if (!inSession(bar.closeTime)) continue;

    const atrV = a14[i]!;
    if (!Number.isFinite(atrV) || atrV <= 0) continue;
    const atrPips = atrV / pip;
    if (atrPips < MIN_ATR_PIPS) continue;

    const winStart = Math.max(0, i - LOOKBACK);
    const window = m5.slice(winStart, i); // bars preceding the breakout candle
    if (window.length < LOOKBACK) continue;
    const rangeHi = Math.max(...window.map((b) => b.high));
    const rangeLo = Math.min(...window.map((b) => b.low));
    const rangeWidth = rangeHi - rangeLo;
    const rangeWidthAtr = rangeWidth / atrV;
    if (rangeWidthAtr < MIN_RANGE_ATR || rangeWidthAtr > MAX_RANGE_ATR) continue;

    // Break direction
    let dir: "long" | "short" | null = null;
    let level = 0;
    if (bar.close > rangeHi + BREAK_THRESHOLD * atrV) { dir = "long"; level = rangeHi; }
    else if (bar.close < rangeLo - BREAK_THRESHOLD * atrV) { dir = "short"; level = rangeLo; }
    else continue;

    // Not chasing
    const extension = dir === "long" ? bar.close - level : level - bar.close;
    if (extension > MAX_EXTENSION_ATR * atrV) continue;

    // Confirmation (bar closes in direction)
    const closedDir = dir === "long" ? bar.close > bar.open : bar.close < bar.open;
    if (!closedDir) continue;

    // H1 alignment
    const h1b = htfBias(bar.closeTime, h1, h1_e21, h1_e50);
    if (h1b !== (dir === "long" ? 1 : -1)) continue;

    // Spread
    const spreadPips = (bar.askClose - bar.bidClose) / pip;
    if (!Number.isFinite(spreadPips) || spreadPips > spMax) continue;

    // Geometry: stop = level - 0.5*ATR for long
    const entry = dir === "long" ? bar.askClose : bar.bidClose;
    const stop = dir === "long" ? level - STOP_ATR * atrV : level + STOP_ATR * atrV;
    const stopDist = Math.abs(entry - stop);
    if (stopDist <= 0 || stopDist / entry < 1e-6) continue;
    const target = dir === "long" ? entry + TARGET_R * stopDist : entry - TARGET_R * stopDist;

    const forward = m5.slice(i + 1);
    const res = labelOutcome(dir, entry, stop, target, bar.closeTime, forward as never);
    const resolvedMs = res.resolvedAt ? Date.parse(res.resolvedAt) : (t + 4 * 3600e3); // shorter horizon for M5

    trades.push({
      pair, direction: dir, decisionTime: bar.closeTime,
      entry, stop, target,
      stopPips: stopDist / pip, targetPips: (TARGET_R * stopDist) / pip, spreadPips,
      atrPips, rangeWidthAtr, sessionHourEt: etHour(bar.closeTime),
      outcome: res.outcome, resultR: res.resultR, resolvedAt: res.resolvedAt,
    });
    taken++;
    openUntilMs = resolvedMs;
    if (trades.length >= TARGET_TRADES) break;
  }
  console.log(`  ${pair}: ${taken} trades taken`);
  if (trades.length >= TARGET_TRADES) break;
}

writeFileSync(OUT, JSON.stringify({
  scope: { engine: "M5 breakout scalper", pairs: PAIRS, yearsBack: YEARS_BACK },
  trades,
}, null, 1));

// Summary
type Agg = { n: number; w: number; l: number; totalR: number; grossW: number; grossL: number };
const empty = (): Agg => ({ n: 0, w: 0, l: 0, totalR: 0, grossW: 0, grossL: 0 });
const push = (a: Agg, r: number) => { a.n++; a.totalR += r; if (r > 0) { a.w++; a.grossW += r; } else if (r < 0) { a.l++; a.grossL += r; } };
const overall = empty();
const byPair = new Map<string, Agg>();
for (const t of trades) {
  if (t.outcome === "ambiguous" || t.resultR === null) continue;
  push(overall, t.resultR);
  const bp = byPair.get(t.pair) ?? empty(); push(bp, t.resultR); byPair.set(t.pair, bp);
}
const fmt = (a: Agg) => `n=${a.n} winrate=${a.n ? (100 * a.w / a.n).toFixed(1) : "0"}% expR=${a.n ? (a.totalR / a.n).toFixed(3) : "0"} totalR=${a.totalR >= 0 ? "+" : ""}${a.totalR.toFixed(2)} PF=${a.grossL < 0 ? (a.grossW / Math.abs(a.grossL)).toFixed(2) : "∞"}`;

console.log(`\n=== OVERALL === ${fmt(overall)}`);
console.log(`\n=== BY PAIR ===`);
for (const [p, ag] of byPair) console.log(`  ${p}: ${fmt(ag)}`);

// trades/day estimation
const daysSpan = (Date.parse(trades[trades.length - 1]!.decisionTime) - Date.parse(trades[0]!.decisionTime)) / 86400e3;
const tradesPerDay = trades.length / daysSpan;
console.log(`\ntrade rate: ${tradesPerDay.toFixed(2)}/day over ${daysSpan.toFixed(0)} days`);

console.log(`\nwrote ${OUT}`);
process.exit(0);
