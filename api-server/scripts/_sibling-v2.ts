/**
 * Sibling hunt off breakout-v2 meta-edge (H1 compression).
 * - momentum: continuation bar after compress break
 * - meanrev: fade when range is WIDE (≥3.5 ATR) with rejection close
 * - ema: retest of mid-range after compress break
 * Holdout sealed 2025-01-01. Claim WINS only if n≥40 and CI>0.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateAtrValues, calculateEmaValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2016-01-01T00:00:00Z");
const instruments = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_CHF"];

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = {
  family: string; name: string; instrument: string; ms: number;
  direction: "long" | "short"; entry: number; stop: number; qi: number; targetR: number;
};

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

const setups: Setup[] = [];
const quotesBy = new Map<string, Quote[]>();

for (const instrument of instruments) {
  let pip: number;
  try { pip = pipSizeFor(instrument as never); } catch { continue; }
  const { candles, quotes } = await load(instrument);
  if (candles.length < 1000) continue;
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const closes = candles.map((c) => c.close);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));

  for (let i = 25; i < candles.length; i += 1) {
    const bar = candles[i]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;
    const a = atr[i]; const e21 = ema21[i]; const e50 = ema50[i];
    if (a == null || !(a > 0) || e21 == null || e50 == null) continue;
    const qi = qIndex.get(bar.time);
    if (qi == null) continue;
    const quote = quotes[qi]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || spreadPips > 3.5) continue;

    const window = candles.slice(i - 20, i);
    const rh = Math.max(...window.map((c) => c.high));
    const rl = Math.min(...window.map((c) => c.low));
    const rangeAtr = (rh - rl) / a;
    const brokeUp = bar.close > rh;
    const brokeDn = bar.close < rl;

    // Reference: compress break itself
    if (rangeAtr <= 2.2 && (brokeUp || brokeDn)) {
      const direction = brokeUp ? "long" as const : "short" as const;
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
      setups.push({ family: "breakout", name: "compress≤2.2 1R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 1 });
    }

    // MOMENTUM: next bar continues after a compress break on prior bar
    if (i >= 26) {
      const prev = candles[i - 1]!;
      const w2 = candles.slice(i - 21, i - 1);
      const rh2 = Math.max(...w2.map((c) => c.high));
      const rl2 = Math.min(...w2.map((c) => c.low));
      const aPrev = atr[i - 1] ?? a;
      const range2 = (rh2 - rl2) / aPrev;
      if (range2 <= 2.2) {
        const prevUp = prev.close > rh2;
        const prevDn = prev.close < rl2;
        if (prevUp || prevDn) {
          const direction = prevUp ? "long" as const : "short" as const;
          const cont = direction === "long"
            ? bar.close > prev.close && bar.close > bar.open
            : bar.close < prev.close && bar.close < bar.open;
          if (cont) {
            const entry = direction === "long" ? quote.askClose : quote.bidClose;
            const stop = direction === "long" ? entry - a : entry + a;
            for (const targetR of [0.75, 1.0] as const) {
              setups.push({ family: "momentum", name: `compress-cont ${targetR}R`, instrument, ms: atMs, direction, entry, stop, qi, targetR });
            }
          }
        }
      }
    }

    // MEANREV: wide range (≥3.5) with rejection back inside
    if (rangeAtr >= 3.5) {
      const rejHigh = bar.high > rh && bar.close < rh && bar.close < bar.open;
      const rejLow = bar.low < rl && bar.close > rl && bar.close > bar.open;
      if (rejHigh || rejLow) {
        const direction = rejHigh ? "short" as const : "long" as const;
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        const stop = direction === "long" ? entry - a : entry + a;
        for (const targetR of [0.5, 0.75, 1.0] as const) {
          setups.push({ family: "meanrev", name: `wide-reject ${targetR}R`, instrument, ms: atMs, direction, entry, stop, qi, targetR });
        }
      }
    }

    // EMA: retest mid of a recent compress break (2–8 bars ago)
    for (let back = 2; back <= 8; back += 1) {
      const j = i - back;
      if (j < 20) continue;
      const w = candles.slice(j - 20, j);
      const rH = Math.max(...w.map((c) => c.high));
      const rL = Math.min(...w.map((c) => c.low));
      const aJ = atr[j];
      if (aJ == null || !(aJ > 0)) continue;
      if ((rH - rL) / aJ > 2.2) continue;
      const b = candles[j]!;
      let signal: "long" | "short" | null = null;
      if (b.close > rH) signal = "long";
      if (b.close < rL) signal = "short";
      if (!signal) continue;
      const mid = (rH + rL) / 2;
      if (signal === "long" && e21 > e50 && bar.low <= mid + a * 0.2 && bar.close > mid && bar.close > bar.open) {
        const entry = quote.askClose;
        const stop = Math.min(rL, entry - a * 0.9);
        setups.push({ family: "ema", name: "compress-retest 1R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 1 });
        setups.push({ family: "ema", name: "compress-retest 0.75R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 0.75 });
      }
      if (signal === "short" && e21 < e50 && bar.high >= mid - a * 0.2 && bar.close < mid && bar.close < bar.open) {
        const entry = quote.bidClose;
        const stop = Math.max(rH, entry + a * 0.9);
        setups.push({ family: "ema", name: "compress-retest 1R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 1 });
        setups.push({ family: "ema", name: "compress-retest 0.75R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 0.75 });
      }
      break;
    }
  }
  console.log(instrument, "ok");
}

{
  const seen = new Set<string>();
  const out: Setup[] = [];
  for (const s of setups) {
    const k = `${s.family}|${s.name}|${s.instrument}|${s.ms}|${s.direction}|${s.targetR}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  setups.length = 0;
  setups.push(...out);
}

function simulate(name: string, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => s.name === name && s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(`${s.instrument}|${s.family}`) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    const target = s.direction === "long" ? s.entry + risk * s.targetR : s.entry - risk * s.targetR;
    const quotes = quotesBy.get(s.instrument)!;
    const forward = quotes.slice(s.qi + 1, s.qi + 24);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(`${s.instrument}|${s.family}`, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { name, family: eligible[0]?.family ?? "?", n, avg: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    name, family: eligible[0]?.family ?? "?", n,
    avg: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const names = [...new Set(setups.map((s) => s.name))];
const dev = names.map((n) => simulate(n, REPLAY, HOLDOUT));
console.log("=== DEV ===");
console.table(dev.map(({ _mean, ...r }) => r));

console.log("\n=== HOLDOUT ===");
const wins: string[] = [];
for (const family of ["breakout", "momentum", "meanrev", "ema"]) {
  console.log(`\n# ${family}`);
  for (const row of dev.filter((r) => r.family === family).sort((a, b) => b._mean - a._mean)) {
    const h = simulate(row.name, HOLDOUT, null);
    const mark = h.verdict === "WINS" ? " ★★★" : "";
    if (h.verdict === "WINS") wins.push(`${family}: ${row.name}`);
    console.log(`${row.name}: dev ${row.avg} (n=${row.n}) → hold ${h.avg} (${h.verdict}, n=${h.n}) ${h.ci}${mark}`);
  }
}
console.log("\nWINS:", wins.length ? wins.join(" | ") : "none");
process.exit(0);
