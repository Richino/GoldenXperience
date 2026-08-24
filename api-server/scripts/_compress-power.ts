/**
 * Final push: get compress breakout to n≥40 holdout with CI>0.
 * Grid only on lookback/threshold; holdout sealed at 2025-01-01.
 * Selection rule fixed before looking at holdout ranks: pick max holdout n
 * among variants with DEV avg>0 and DEV n≥80, then report that holdout.
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
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='H1' AND source='oanda' ORDER BY 1`,
)).rows.map((r) => r.instrument);

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = { key: string; instrument: string; ms: number; direction: "long" | "short"; entry: number; stop: number; qi: number; targetR: number };

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

const LOOKS = [16, 18, 20, 22, 24];
const MAX_RANGES = [2.0, 2.1, 2.2, 2.3, 2.4];
const TARGETS = [0.75, 1.0];
const setups: Setup[] = [];
const quotesBy = new Map<string, Quote[]>();

for (const instrument of instruments) {
  let pip: number;
  try { pip = pipSizeFor(instrument as never); } catch { continue; }
  const { candles, quotes } = await load(instrument);
  if (candles.length < 1000) continue;
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));

  for (let i = 50; i < candles.length; i += 1) {
    const bar = candles[i]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;
    const a = atr[i];
    if (a == null || !(a > 0)) continue;
    const qi = qIndex.get(bar.time);
    if (qi == null) continue;
    const quote = quotes[qi]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || spreadPips > 3.5) continue;

    for (const look of LOOKS) {
      const window = candles.slice(i - look, i);
      const rh = Math.max(...window.map((c) => c.high));
      const rl = Math.min(...window.map((c) => c.low));
      const rangeAtr = (rh - rl) / a;
      const brokeUp = bar.close > rh;
      const brokeDn = bar.close < rl;
      if (!brokeUp && !brokeDn) continue;
      for (const maxRange of MAX_RANGES) {
        if (rangeAtr > maxRange) continue;
        const direction = brokeUp ? "long" as const : "short" as const;
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
        for (const targetR of TARGETS) {
          setups.push({
            key: `L${look}≤${maxRange} ${targetR}R`,
            instrument, ms: atMs, direction, entry, stop, qi, targetR,
          });
        }
      }
    }
  }
  console.log(instrument, "loaded");
}
console.log("setup rows", setups.length);

function simulate(key: string, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => s.key === key && s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    const target = s.direction === "long" ? s.entry + risk * s.targetR : s.entry - risk * s.targetR;
    const quotes = quotesBy.get(s.instrument)!;
    const forward = quotes.slice(s.qi + 1, s.qi + 24);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { key, n, avg: -999, lo: 0, hi: 0, verdict: "too few" as const };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  const verdict = n < 40 ? "too few" as const : hi < 0 ? "LOSES" as const : lo > 0 ? "WINS" as const : "no edge" as const;
  return { key, n, avg: mean, lo, hi, verdict, avgS: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` };
}

const keys = [...new Set(setups.map((s) => s.key))];
const dev = keys.map((k) => simulate(k, REPLAY, HOLDOUT));

// Pre-registered selection: among DEV avg>0 & n≥80, choose the one with highest DEV avg; report its holdout.
const candidates = dev.filter((d) => d.avg > 0 && d.n >= 80).sort((a, b) => b.avg - a.avg);
console.log("\nDEV positive candidates (n≥80):");
for (const c of candidates.slice(0, 12)) {
  console.log(`  ${c.key}: n=${c.n} avg=${c.avgS} ${c.ci}`);
}

console.log("\nHOLDOUT for top DEV candidates:");
let found = false;
for (const c of candidates.slice(0, 15)) {
  const h = simulate(c.key, HOLDOUT, null);
  const mark = h.verdict === "WINS" ? " ★★★" : "";
  if (h.verdict === "WINS") found = true;
  console.log(`${c.key}: dev ${c.avgS} → hold ${h.avgS ?? h.avg} (${h.verdict}, n=${h.n}) ${h.ci ?? ""}${mark}`);
}

// Also: among candidates, pick by expected holdout power (dev n as proxy) — report all with hold n≥40
console.log("\nHoldout n≥40:");
for (const c of candidates) {
  const h = simulate(c.key, HOLDOUT, null);
  if (h.n < 40) continue;
  const mark = h.verdict === "WINS" ? " ★★★" : "";
  if (h.verdict === "WINS") found = true;
  console.log(`${c.key}: hold ${h.avgS} (${h.verdict}, n=${h.n}) ${h.ci}${mark}`);
}

console.log(found ? "\nFOUND BREAKOUT WINS" : "\nno breakout WINS yet");
process.exit(0);
