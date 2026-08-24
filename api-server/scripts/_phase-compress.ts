/**
 * Phase-shifted H1 compressed breakout — same L20≤2.2ATR 1R rule on
 * H1 aggregates starting at :00/:15/:30/:45 from M15, to multiply rare events
 * without loosening the filter. Holdout sealed 2025-01-01. One position per
 * instrument across phases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2016-01-01T00:00:00Z");
const instruments = (await query<{ instrument: string }>(
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='M15' AND source='oanda' ORDER BY 1`,
)).rows.map((r) => r.instrument);

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = {
  instrument: string; ms: number; direction: "long" | "short";
  entry: number; stop: number; phase: number; maxRange: number; targetR: number;
  forward: Quote[];
};

function aggregateH1(m15: Candle[], phase: number): Candle[] {
  // phase 0..3 = start offset in M15 bars within each hour group
  const out: Candle[] = [];
  for (let i = phase; i + 4 <= m15.length; i += 4) {
    const bars = m15.slice(i, i + 4);
    // require same UTC hour for a clean synthetic H1
    const hours = new Set(bars.map((b) => b.time.slice(0, 13)));
    if (hours.size !== 1) continue;
    out.push({
      time: bars[3]!.time,
      open: bars[0]!.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[3]!.close,
    });
  }
  return out;
}

function aggregateQuotes(m15q: Quote[], phase: number): Quote[] {
  const out: Quote[] = [];
  for (let i = phase; i + 4 <= m15q.length; i += 4) {
    const bars = m15q.slice(i, i + 4);
    const hours = new Set(bars.map((b) => b.closeTime.slice(0, 13)));
    if (hours.size !== 1) continue;
    out.push({
      closeTime: bars[3]!.closeTime,
      bidOpen: bars[0]!.bidOpen,
      bidHigh: Math.max(...bars.map((b) => b.bidHigh)),
      bidLow: Math.min(...bars.map((b) => b.bidLow)),
      bidClose: bars[3]!.bidClose,
      askOpen: bars[0]!.askOpen,
      askHigh: Math.max(...bars.map((b) => b.askHigh)),
      askLow: Math.min(...bars.map((b) => b.askLow)),
      askClose: bars[3]!.askClose,
    });
  }
  return out;
}

async function loadM15(instrument: string) {
  const candles = (await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float FROM market_candles
     WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    time: new Date(r.close_time as string).toISOString(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
  const quotes = (await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
     FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    closeTime: new Date(r.close_time as string).toISOString(),
    bidOpen: Number(r.bid_open), bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), bidClose: Number(r.bid_close),
    askOpen: Number(r.ask_open), askHigh: Number(r.ask_high), askLow: Number(r.ask_low), askClose: Number(r.ask_close),
  }));
  return { candles, quotes };
}

const setups: Setup[] = [];

for (const instrument of instruments) {
  let pip: number;
  try { pip = pipSizeFor(instrument as never); } catch { continue; }
  const { candles: m15, quotes: m15q } = await loadM15(instrument);
  if (m15.length < 2000) { console.log(instrument, "thin"); continue; }

  for (const phase of [0, 1, 2, 3]) {
    const h1 = aggregateH1(m15, phase);
    const hq = aggregateQuotes(m15q, phase);
    if (h1.length < 100 || hq.length < 100) continue;
    const atr = calculateAtrValues(h1 as never, 14);
    const qIndex = new Map(hq.map((q, i) => [q.closeTime, i]));

    for (let i = 25; i < h1.length; i += 1) {
      const bar = h1[i]!;
      const atMs = Date.parse(bar.time);
      if (atMs < REPLAY) continue;
      if (!dayTradingSession(new Date(atMs)).open) continue;
      const a = atr[i];
      if (a == null || !(a > 0)) continue;
      const qi = qIndex.get(bar.time);
      if (qi == null) continue;
      const quote = hq[qi]!;
      const spreadPips = (quote.askClose - quote.bidClose) / pip;
      if (!(spreadPips > 0) || spreadPips > 3.5) continue;

      const window = h1.slice(i - 20, i);
      const rh = Math.max(...window.map((c) => c.high));
      const rl = Math.min(...window.map((c) => c.low));
      const rangeAtr = (rh - rl) / a;
      const brokeUp = bar.close > rh;
      const brokeDn = bar.close < rl;
      if (!brokeUp && !brokeDn) continue;

      for (const maxRange of [2.2, 2.3] as const) {
        if (rangeAtr > maxRange) continue;
        const direction = brokeUp ? "long" as const : "short" as const;
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
        // Forward path: next 24 synthetic H1 quotes of THIS phase
        const forward = hq.slice(qi + 1, qi + 25);
        if (forward.length < 4) continue;
        for (const targetR of [0.75, 1.0] as const) {
          setups.push({
            instrument, ms: atMs, direction, entry, stop, phase, maxRange, targetR, forward,
          });
        }
      }
    }
  }
  console.log(instrument, "phases done");
}
console.log("setups", setups.length);

function simulate(maxRange: number, targetR: number, fromMs: number, toMs: number | null) {
  const eligible = setups
    .filter((s) => s.maxRange === maxRange && s.targetR === targetR && s.ms >= fromMs && (toMs === null || s.ms < toMs))
    .sort((a, b) => a.ms - b.ms || a.phase - b.phase);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    // One position per instrument — phases compete, earliest wins
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    const target = s.direction === "long" ? s.entry + risk * s.targetR : s.entry - risk * s.targetR;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), s.forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms + 3_600_000);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { maxRange, targetR, n, avg: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    maxRange, targetR, n,
    avg: mean.toFixed(3),
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const variants = [
  { maxRange: 2.2, targetR: 1.0 },
  { maxRange: 2.2, targetR: 0.75 },
  { maxRange: 2.3, targetR: 1.0 },
  { maxRange: 2.3, targetR: 0.75 },
];

console.log("=== DEV ===");
for (const v of variants) {
  const d = simulate(v.maxRange, v.targetR, REPLAY, HOLDOUT);
  console.log(`≤${v.maxRange} ${v.targetR}R: n=${d.n} avg=${d.avg} ${d.verdict} ${d.ci}`);
}

console.log("\n=== HOLDOUT ===");
let wins = false;
for (const v of variants) {
  const h = simulate(v.maxRange, v.targetR, HOLDOUT, null);
  const mark = h.verdict === "WINS" ? " ★★★" : "";
  if (h.verdict === "WINS") wins = true;
  console.log(`≤${v.maxRange} ${v.targetR}R: hold ${h.avg} (${h.verdict}, n=${h.n}) ${h.ci}${mark}`);
}
console.log(wins ? "FOUND WINS" : "no WINS");
process.exit(0);
