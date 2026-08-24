/**
 * Power-up H1 compressed breakout + sibling geometries for the other families.
 * Holdout sealed from 2025-08-01. Claim WINS only if CI lower bound > 0 and n≥40.
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

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2016-01-01T00:00:00Z");
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_CHF"];

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

type Family = "breakout" | "meanrev" | "momentum" | "ema";
type Setup = {
  family: Family; name: string; instrument: string; ms: number;
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

for (const instrument of PAIRS) {
  let pip: number;
  try { pip = pipSizeFor(instrument as never); } catch { continue; }
  const { candles, quotes } = await load(instrument);
  if (candles.length < 800) { console.log(instrument, "thin"); continue; }
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const closes = candles.map((c) => c.close);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
  let n = 0;

  for (let i = 50; i < candles.length; i += 1) {
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

    // Shared range stats for lookbacks 12 and 20
    for (const look of [12, 16, 20] as const) {
      const prior = candles.slice(i - look, i);
      const rangeHigh = Math.max(...prior.map((c) => c.high));
      const rangeLow = Math.min(...prior.map((c) => c.low));
      const rangeAtr = (rangeHigh - rangeLow) / a;
      const bodyAtr = Math.abs(bar.close - bar.open) / a;
      const brokeUp = bar.close > rangeHigh;
      const brokeDn = bar.close < rangeLow;

      // BREAKOUT: compressed range break
      for (const maxRange of [2.0, 2.2, 2.5] as const) {
        if (rangeAtr > maxRange) continue;
        if (!brokeUp && !brokeDn) continue;
        const direction = brokeUp ? "long" as const : "short" as const;
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        let stop = direction === "long" ? Math.min(rangeLow, entry - a * 0.9) : Math.max(rangeHigh, entry + a * 0.9);
        setups.push({
          family: "breakout",
          name: `bo L${look}≤${maxRange}ATR 1R`,
          instrument, ms: atMs, direction, entry, stop, qi, targetR: 1,
        });
        n += 1;
      }

      // MEANREV: fade EXPANDED range poke (range wide, price tags extreme, close back inside)
      if (rangeAtr >= 3.0 && look === 20) {
        const taggedHigh = bar.high > rangeHigh && bar.close < rangeHigh;
        const taggedLow = bar.low < rangeLow && bar.close > rangeLow;
        if (taggedHigh || taggedLow) {
          const direction = taggedHigh ? "short" as const : "long" as const;
          const entry = direction === "long" ? quote.askClose : quote.bidClose;
          const stop = direction === "long" ? entry - a : entry + a;
          setups.push({
            family: "meanrev", name: "fade wide-range poke 0.75R",
            instrument, ms: atMs, direction, entry, stop, qi, targetR: 0.75,
          });
          n += 1;
        }
      }
    }

    // MOMENTUM: 4-bar thrust ≥1.2ATR with EMA align, stop 1ATR, target 1R
    const ret4 = (bar.close - candles[i - 4]!.close) / a;
    if (Math.abs(ret4) >= 1.2) {
      const direction = ret4 > 0 ? "long" as const : "short" as const;
      const aligned = direction === "long" ? e21 > e50 : e21 < e50;
      if (aligned) {
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        const stop = direction === "long" ? entry - a : entry + a;
        setups.push({
          family: "momentum", name: "thrust4 ≥1.2ATR EMA 1R",
          instrument, ms: atMs, direction, entry, stop, qi, targetR: 1,
        });
        setups.push({
          family: "momentum", name: "thrust4 ≥1.2ATR EMA 0.75R",
          instrument, ms: atMs, direction, entry, stop, qi, targetR: 0.75,
        });
        n += 2;
      }
    }

    // EMA: pullback to ema21 in trend, confirmation candle, stop 1ATR, 1R
    const zonePad = a * 0.35;
    if (e21 > e50 && bar.low <= e21 + zonePad && bar.close > e21 && bar.close > bar.open) {
      const entry = quote.askClose;
      const stop = Math.min(...candles.slice(i - 5, i + 1).map((c) => c.low), entry - a * 0.9);
      setups.push({ family: "ema", name: "ema21 pullback long 1R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 1 });
      setups.push({ family: "ema", name: "ema21 pullback long 0.75R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 0.75 });
      n += 2;
    }
    if (e21 < e50 && bar.high >= e21 - zonePad && bar.close < e21 && bar.close < bar.open) {
      const entry = quote.bidClose;
      const stop = Math.max(...candles.slice(i - 5, i + 1).map((c) => c.high), entry + a * 0.9);
      setups.push({ family: "ema", name: "ema21 pullback short 1R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 1 });
      setups.push({ family: "ema", name: "ema21 pullback short 0.75R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 0.75 });
      n += 2;
    }
  }
  console.log(instrument, "raw tags", n);
}

// Deduplicate identical (family,name,instrument,ms,direction) keeping first
{
  const seen = new Set<string>();
  const deduped: Setup[] = [];
  for (const s of setups) {
    const key = `${s.family}|${s.name}|${s.instrument}|${s.ms}|${s.direction}|${s.targetR}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  setups.length = 0;
  setups.push(...deduped);
}
console.log("unique setups", setups.length);

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
  if (n < 2) return { name, n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999, family: eligible[0]?.family ?? "?" };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    name, family: eligible[0]?.family ?? "?", n,
    avg: mean.toFixed(3),
    win: ((100 * rs.filter((r) => r > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const names = [...new Set(setups.map((s) => s.name))];
console.log("\n=== DEV ===");
const dev = names.map((name) => simulate(name, REPLAY, HOLDOUT));
console.table(dev.map(({ _mean, ...r }) => r));

console.log("\n=== HOLDOUT (by family best + all positive-dev) ===");
const wins: string[] = [];
for (const family of ["breakout", "meanrev", "momentum", "ema"] as Family[]) {
  const ranked = dev.filter((r) => r.family === family && r.n >= 40).sort((a, b) => b._mean - a._mean);
  console.log(`\n# ${family}`);
  for (const row of ranked.slice(0, 4)) {
    const hold = simulate(row.name, HOLDOUT, null);
    const mark = hold.verdict === "WINS" ? " ★★★" : "";
    if (hold.verdict === "WINS") wins.push(`${family}: ${row.name}`);
    console.log(`${row.name}: dev ${row.avg} (n=${row.n}) → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ${hold.ci}${mark}`);
  }
}
console.log("\nWINS:", wins.length ? wins.join(" | ") : "none");
process.exit(0);
