/**
 * Replay a 4h-hold signal strategy from the only predictor that cleared costs:
 * 1h momentum decile → hold 4h (16 M15 bars), flat exit. No stop/target first —
 * measure raw expectancy, then add ATR stops.
 *
 * Development ranks; holdout sealed from 2025-08-01.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2023-08-01T00:00:00Z");
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const HOLD_BARS = 16; // 4h
const STEP = HOLD_BARS; // non-overlapping
const PER_HOUR = 4;

type Bar = {
  time: string; ms: number; open: number; high: number; low: number; close: number;
  atr: number; bid: number; ask: number; etMinutes: number;
};

function atr14(highs: number[], lows: number[], closes: number[]) {
  const out: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i += 1) {
    const tr = Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!));
    out[i] = i < 14 ? tr : (out[i - 1]! * 13 + tr) / 14;
  }
  // seed
  let sum = 0;
  for (let i = 1; i <= 14 && i < closes.length; i += 1) {
    sum += Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!));
    if (i === 14) out[i] = sum / 14;
  }
  for (let i = 15; i < closes.length; i += 1) {
    const tr = Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!));
    out[i] = (out[i - 1]! * 13 + tr) / 14;
  }
  return out;
}

function etMinutes(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
}

async function loadPair(instrument: string): Promise<Bar[]> {
  const candles = await query<Record<string, unknown>>(
    `SELECT c.close_time, c.open::float, c.high::float, c.low::float, c.close::float,
            q.bid_close::float AS bid, q.ask_close::float AS ask
       FROM market_candles c
       JOIN market_candle_quotes q ON q.instrument=c.instrument AND q.timeframe=c.timeframe AND q.source=c.source AND q.close_time=c.close_time
      WHERE c.instrument=$1 AND c.timeframe='M15' AND c.source='oanda'
      ORDER BY c.close_time`,
    [instrument],
  );
  const rows = candles.rows;
  const highs = rows.map((r) => Number(r.high));
  const lows = rows.map((r) => Number(r.low));
  const closes = rows.map((r) => Number(r.close));
  const atr = atr14(highs, lows, closes);
  return rows.map((r, i) => {
    const ms = Date.parse(String(r.close_time));
    return {
      time: new Date(ms).toISOString(), ms,
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      atr: atr[i]!, bid: Number(r.bid), ask: Number(r.ask),
      etMinutes: etMinutes(new Date(ms)),
    };
  });
}

type Trade = { ms: number; instrument: string; direction: "long" | "short"; resultR: number; resultAtr: number };

function summarise(label: string, trades: Trade[]) {
  const n = trades.length;
  if (n < 2) return { label, n, avg_r: "-", avg_atr: "-", win: "-", ci: "-", verdict: "too few" };
  const net = trades.reduce((s, t) => s + t.resultR, 0);
  const mean = net / n;
  const atrMean = trades.reduce((s, t) => s + t.resultAtr, 0) / n;
  const se = Math.sqrt(trades.reduce((s, t) => s + (t.resultR - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  const wins = trades.filter((t) => t.resultR > 0).length;
  return {
    label, n,
    avg_r: mean.toFixed(3),
    avg_atr: atrMean.toFixed(3),
    win: ((100 * wins) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

type Variant = {
  name: string;
  /** Take long when mom1h rank ≥ this quantile; short when ≤ 1-quantile. */
  quantile: number;
  stopAtr: number | null;
  targetAtr: number | null;
};

const VARIANTS: Variant[] = [
  { name: "top/bottom 10% · flat 4h", quantile: 0.9, stopAtr: null, targetAtr: null },
  { name: "top/bottom 15% · flat 4h", quantile: 0.85, stopAtr: null, targetAtr: null },
  { name: "top/bottom 20% · flat 4h", quantile: 0.8, stopAtr: null, targetAtr: null },
  { name: "top/bottom 10% · stop1 / tgt0.5 ATR", quantile: 0.9, stopAtr: 1.0, targetAtr: 0.5 },
  { name: "top/bottom 10% · stop1 / tgt0.75 ATR", quantile: 0.9, stopAtr: 1.0, targetAtr: 0.75 },
  { name: "top/bottom 10% · stop1.25 / tgt0.6 ATR", quantile: 0.9, stopAtr: 1.25, targetAtr: 0.6 },
  { name: "top/bottom 15% · stop1 / tgt0.5 ATR", quantile: 0.85, stopAtr: 1.0, targetAtr: 0.5 },
  { name: "top/bottom 10% · stop0.8 / tgt0.4 ATR", quantile: 0.9, stopAtr: 0.8, targetAtr: 0.4 },
];

const series = new Map<string, Bar[]>();
for (const instrument of PAIRS) {
  series.set(instrument, await loadPair(instrument));
  console.log(instrument, series.get(instrument)!.length, "bars");
}

/** Build development mom1h distribution to set quantile thresholds without peeking holdout. */
function mom1h(bars: Bar[], i: number) {
  return (bars[i]!.close - bars[i - PER_HOUR]!.close) / bars[i]!.atr;
}

function thresholds(fromMs: number, toMs: number) {
  const values: number[] = [];
  for (const instrument of PAIRS) {
    const bars = series.get(instrument)!;
    for (let i = 50; i + HOLD_BARS < bars.length; i += STEP) {
      const bar = bars[i]!;
      if (bar.ms < fromMs || bar.ms >= toMs) continue;
      if (bar.atr <= 0) continue;
      if (bar.etMinutes < 3 * 60 || bar.etMinutes >= 12 * 60) continue; // enter only if 4h fits before 16:00
      values.push(mom1h(bars, i));
    }
  }
  values.sort((a, b) => a - b);
  return (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
}

function runVariant(variant: Variant, fromMs: number, toMs: number | null, thr: (q: number) => number): Trade[] {
  const hi = thr(variant.quantile);
  const lo = thr(1 - variant.quantile);
  const trades: Trade[] = [];

  for (const instrument of PAIRS) {
    const bars = series.get(instrument)!;
    const pip = pipSizeFor(instrument as never);
    let nextOk = 0;
    for (let i = 50; i + HOLD_BARS < bars.length; i += STEP) {
      const bar = bars[i]!;
      if (bar.ms < fromMs) continue;
      if (toMs !== null && bar.ms >= toMs) continue;
      if (bar.ms < nextOk) continue;
      if (bar.atr <= 0) continue;
      if (bar.etMinutes < 3 * 60 || bar.etMinutes >= 12 * 60) continue;

      const mom = mom1h(bars, i);
      let direction: "long" | "short" | null = null;
      if (mom >= hi) direction = "long";
      else if (mom <= lo) direction = "short";
      if (!direction) continue;

      const entry = direction === "long" ? bar.ask : bar.bid;
      const stop = variant.stopAtr === null ? null : direction === "long" ? entry - variant.stopAtr * bar.atr : entry + variant.stopAtr * bar.atr;
      const target = variant.targetAtr === null ? null : direction === "long" ? entry + variant.targetAtr * bar.atr : entry - variant.targetAtr * bar.atr;
      const risk = stop === null ? bar.atr : Math.abs(entry - stop);

      let exit = direction === "long" ? bars[i + HOLD_BARS]!.bid : bars[i + HOLD_BARS]!.ask;
      let exitI = i + HOLD_BARS;
      if (stop !== null && target !== null) {
        for (let j = i + 1; j <= i + HOLD_BARS; j += 1) {
          const b = bars[j]!;
          if (direction === "long") {
            if (b.low <= stop) { exit = stop; exitI = j; break; }
            if (b.high >= target) { exit = target; exitI = j; break; }
          } else {
            if (b.high >= stop) { exit = stop; exitI = j; break; }
            if (b.low <= target) { exit = target; exitI = j; break; }
          }
        }
      }

      const pnl = direction === "long" ? exit - entry : entry - exit;
      const resultR = pnl / risk;
      const resultAtr = pnl / bar.atr;
      // spread sanity: entry already ask/bid; exit opposite side on flat
      trades.push({ ms: bar.ms, instrument, direction, resultR, resultAtr });
      nextOk = bars[exitI]!.ms;
    }
  }
  return trades;
}

const thrDev = thresholds(REPLAY, HOLDOUT);
console.log("\n=== DEVELOPMENT ===");
const dev = VARIANTS.map((v) => ({ ...summarise(v.name, runVariant(v, REPLAY, HOLDOUT, thrDev)), variant: v }));
console.table(dev.map(({ _mean, variant, ...row }) => row));

console.log("\n=== HOLDOUT (thresholds frozen from development) ===");
const hold = VARIANTS.map((v) => summarise(v.name, runVariant(v, HOLDOUT, null, thrDev)));
console.table(hold.map(({ _mean, ...row }) => row));

const best = [...dev].sort((a, b) => b._mean - a._mean)[0]!;
const bestHold = hold.find((h) => h.label === best.label)!;
console.log(`\nBest on dev: "${best.label}" avgR=${best.avg_r} → holdout ${bestHold.avg_r} (${bestHold.verdict})`);

process.exit(0);
