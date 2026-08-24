/**
 * Cross-pair relative value: when EUR_USD vs GBP_USD (or similar) z-spread
 * stretches, fade the rich leg / buy the cheap leg with H1 ATR stops.
 * Holdout sealed 2025-01-01.
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
const REPLAY = Date.parse("2018-01-01T00:00:00Z");

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

async function load(instrument: string) {
  const candles = (await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float FROM market_candles
     WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    time: new Date(r.close_time as string).toISOString(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
  const quotes = (await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
     FROM market_candle_quotes WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    closeTime: new Date(r.close_time as string).toISOString(),
    bidOpen: Number(r.bid_open), bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), bidClose: Number(r.bid_close),
    askOpen: Number(r.ask_open), askHigh: Number(r.ask_high), askLow: Number(r.ask_low), askClose: Number(r.ask_close),
  }));
  return { candles, quotes };
}

type Pair = { a: string; b: string; name: string };
const PAIRS: Pair[] = [
  { a: "EUR_USD", b: "GBP_USD", name: "EUR/GBP proxy" },
  { a: "EUR_USD", b: "USD_JPY", name: "EUR/JPY proxy" },
  { a: "GBP_USD", b: "USD_JPY", name: "GBP/JPY proxy" },
];

type Setup = {
  name: string; instrument: string; ms: number; direction: "long" | "short";
  entry: number; stop: number; qi: number; targetR: number; quotes: Quote[];
};

const setups: Setup[] = [];

for (const pair of PAIRS) {
  const [A, B] = await Promise.all([load(pair.a), load(pair.b)]);
  const mapB = new Map(B.candles.map((c) => [c.time, c]));
  const qMapA = new Map(A.quotes.map((q, i) => [q.closeTime, { q, i }]));
  const atrA = calculateAtrValues(A.candles as never, 14);
  const pipA = pipSizeFor(pair.a as never);

  // ratio series aligned on A times
  const ratio: number[] = [];
  const idxA: number[] = [];
  for (let i = 0; i < A.candles.length; i += 1) {
    const b = mapB.get(A.candles[i]!.time);
    if (!b || !(b.close > 0)) { ratio.push(NaN); idxA.push(i); continue; }
    // For JPY pairs use EURUSD * USDJPY style; for EUR/GBP use EURUSD/GBPUSD
    const r = pair.b === "USD_JPY"
      ? A.candles[i]!.close * b.close
      : A.candles[i]!.close / b.close;
    ratio.push(r);
    idxA.push(i);
  }

  for (const look of [20, 40] as const) {
    for (const entryZ of [1.75, 2.0, 2.5] as const) {
      for (let i = look + 5; i < A.candles.length; i += 1) {
        const bar = A.candles[i]!;
        const atMs = Date.parse(bar.time);
        if (atMs < REPLAY) continue;
        if (!dayTradingSession(new Date(atMs)).open) continue;
        if (!mapB.has(bar.time)) continue;
        const window = ratio.slice(i - look + 1, i + 1);
        if (window.some((v) => !Number.isFinite(v))) continue;
        const mean = window.reduce((s, v) => s + v, 0) / window.length;
        const sd = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / (window.length - 1));
        if (!(sd > 0)) continue;
        const z = (ratio[i]! - mean) / sd;
        if (Math.abs(z) < entryZ) continue;

        const a = atrA[i];
        if (a == null || !(a > 0)) continue;
        const hit = qMapA.get(bar.time);
        if (!hit) continue;
        const spreadPips = (hit.q.askClose - hit.q.bidClose) / pipA;
        if (!(spreadPips > 0) || spreadPips > 2.5) continue;

        // Fade: ratio rich → short A (or long if cheap). Single-leg for clean R accounting.
        const direction = z > 0 ? "short" as const : "long" as const;
        const entry = direction === "long" ? hit.q.askClose : hit.q.bidClose;
        const stop = direction === "long" ? entry - a : entry + a;
        for (const targetR of [0.75, 1.0] as const) {
          setups.push({
            name: `${pair.name} L${look} z≥${entryZ} fade ${targetR}R`,
            instrument: pair.a, ms: atMs, direction, entry, stop, qi: hit.i, targetR,
            quotes: A.quotes,
          });
        }
      }
    }
  }
  console.log(pair.name, "tagged");
}

function simulate(name: string, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => s.name === name && s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * s.targetR : s.entry - risk * s.targetR;
    const forward = s.quotes.slice(s.qi + 1, s.qi + 24);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { name, n, avg: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    name, n, avg: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const names = [...new Set(setups.map((s) => s.name))];
console.log("variants", names.length, "setups", setups.length);
console.log("=== DEV ===");
const dev = names.map((n) => simulate(n, REPLAY, HOLDOUT));
const ranked = [...dev].sort((a, b) => b._mean - a._mean);
console.table(ranked.slice(0, 12).map(({ _mean, ...r }) => r));

console.log("\n=== HOLDOUT ===");
let wins = false;
for (const row of ranked) {
  if (row.n < 40) continue;
  const h = simulate(row.name, HOLDOUT, null);
  const mark = h.verdict === "WINS" ? " ★★★" : "";
  if (h.verdict === "WINS") wins = true;
  console.log(`${row.name}: dev ${row.avg} → hold ${h.avg} (${h.verdict}, n=${h.n}) ${h.ci}${mark}`);
}
console.log(wins ? "FOUND WINS" : "no WINS");
process.exit(0);
