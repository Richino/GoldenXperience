/**
 * Finalize compressed-breakout sample size for a WINS claim (n≥40, CI>0),
 * then test three sibling rules sharing the same compression meta-edge.
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

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z"); // ~20 months OOS to power rare events
const REPLAY = Date.parse("2016-01-01T00:00:00Z");

const instruments = (await query<{ instrument: string }>(
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='H1' AND source='oanda' ORDER BY 1`,
)).rows.map((r) => r.instrument);
console.log("universe", instruments.join(","));

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

  for (let i = 40; i < candles.length; i += 1) {
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

    // BREAKOUT family: compressed-range break
    if (rangeAtr <= 2.2 && (brokeUp || brokeDn)) {
      const direction = brokeUp ? "long" as const : "short" as const;
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
      for (const targetR of [0.75, 1.0]) {
        setups.push({ family: "breakout", name: `compress≤2.2 ${targetR}R`, instrument, ms: atMs, direction, entry, stop, qi, targetR });
      }
    }
    if (rangeAtr <= 2.4 && (brokeUp || brokeDn)) {
      const direction = brokeUp ? "long" as const : "short" as const;
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
      setups.push({ family: "breakout", name: "compress≤2.4 1R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 1 });
    }

    // MOMENTUM sibling: continuation bar after yesterday's compress break (prior bar was break)
    if (i >= 41) {
      const prev = candles[i - 1]!;
      const w2 = candles.slice(i - 21, i - 1);
      const rh2 = Math.max(...w2.map((c) => c.high));
      const rl2 = Math.min(...w2.map((c) => c.low));
      const range2 = (rh2 - rl2) / (atr[i - 1] ?? a);
      const prevBrokeUp = prev.close > rh2;
      const prevBrokeDn = prev.close < rl2;
      if (range2 <= 2.2 && (prevBrokeUp || prevBrokeDn)) {
        const direction = prevBrokeUp ? "long" as const : "short" as const;
        const continuing = direction === "long" ? bar.close > prev.close && bar.close > bar.open : bar.close < prev.close && bar.close < bar.open;
        if (continuing) {
          const entry = direction === "long" ? quote.askClose : quote.bidClose;
          const stop = direction === "long" ? entry - a : entry + a;
          setups.push({ family: "momentum", name: "compress continuation 1R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 1 });
          setups.push({ family: "momentum", name: "compress continuation 0.75R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 0.75 });
        }
      }
    }

    // MEANREV sibling: fade when range is WIDE (≥3.5ATR) and close tags extreme
    if (rangeAtr >= 3.5) {
      if (bar.close >= rh || bar.high > rh && bar.close < (rh + rl) / 2) {
        const entry = quote.bidClose;
        const stop = entry + a;
        setups.push({ family: "meanrev", name: "fade wide≥3.5 high 0.75R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 0.75 });
      }
      if (bar.close <= rl || bar.low < rl && bar.close > (rh + rl) / 2) {
        const entry = quote.askClose;
        const stop = entry - a;
        setups.push({ family: "meanrev", name: "fade wide≥3.5 low 0.75R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 0.75 });
      }
    }

    // EMA sibling: pullback to mid of compressed range AFTER a break (retest)
    // Detect: within last 6 bars there was a compress break; price now retests mid-range and resumes
    {
      let signal: "long" | "short" | null = null;
      for (let back = 2; back <= 6; back += 1) {
        const j = i - back;
        if (j < 20) continue;
        const w = candles.slice(j - 20, j);
        const rH = Math.max(...w.map((c) => c.high));
        const rL = Math.min(...w.map((c) => c.low));
        const aJ = atr[j];
        if (aJ == null || !(aJ > 0)) continue;
        if ((rH - rL) / aJ > 2.2) continue;
        const b = candles[j]!;
        if (b.close > rH) signal = "long";
        if (b.close < rL) signal = "short";
        if (signal) {
          const mid = (rH + rL) / 2;
          if (signal === "long" && bar.low <= mid + a * 0.15 && bar.close > mid && bar.close > bar.open && e21 > e50) {
            const entry = quote.askClose;
            const stop = Math.min(rL, entry - a * 0.9);
            setups.push({ family: "ema", name: "compress retest long 1R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 1 });
            setups.push({ family: "ema", name: "compress retest long 0.75R", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 0.75 });
          }
          if (signal === "short" && bar.high >= mid - a * 0.15 && bar.close < mid && bar.close < bar.open && e21 < e50) {
            const entry = quote.bidClose;
            const stop = Math.max(rH, entry + a * 0.9);
            setups.push({ family: "ema", name: "compress retest short 1R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 1 });
            setups.push({ family: "ema", name: "compress retest short 0.75R", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 0.75 });
          }
          break;
        }
      }
    }
  }
  console.log(instrument, "ok");
}

// Dedup
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
console.log("setups", setups.length);

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
  if (n < 2) return { name, family: eligible[0]?.family ?? "?", n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999 };
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
console.log("\n=== DEV (pre-2025) ===");
const dev = names.map((n) => simulate(n, REPLAY, HOLDOUT));
console.table(dev.map(({ _mean, ...r }) => r));

console.log("\n=== HOLDOUT (2025+) ===");
const wins: string[] = [];
for (const family of ["breakout", "momentum", "meanrev", "ema"]) {
  console.log(`\n# ${family}`);
  const ranked = dev.filter((r) => r.family === family).sort((a, b) => b._mean - a._mean);
  for (const row of ranked) {
    if (row.n < 25) continue;
    const hold = simulate(row.name, HOLDOUT, null);
    const mark = hold.verdict === "WINS" ? " ★★★" : "";
    if (hold.verdict === "WINS") wins.push(`${family}: ${row.name} hold=${hold.avg} n=${hold.n}`);
    console.log(`${row.name}: dev ${row.avg} (n=${row.n}) → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ${hold.ci}${mark}`);
  }
}
console.log("\nWINS:", wins.length ? wins.join(" | ") : "none");
process.exit(0);
