/**
 * D1 swing hunt on expanded universe (H1 aggregated to daily).
 * Holdout sealed 2025-01-01. Spread paid via last H1 quote of day.
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
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2018-01-01T00:00:00Z");

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = { key: string; family: string; instrument: string; ms: number; direction: "long" | "short"; entry: number; stop: number; qi: number; targetR: number };

const instruments = (await query<{ instrument: string }>(
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='H1' AND source='oanda'
   GROUP BY 1 HAVING count(*) > 8000 ORDER BY 1`,
)).rows.map((r) => r.instrument);

function toDaily(h1: Candle[]): Candle[] {
  const byDay = new Map<string, Candle[]>();
  for (const bar of h1) {
    const key = bar.time.slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(bar);
    byDay.set(key, list);
  }
  const out: Candle[] = [];
  for (const [, bars] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (bars.length < 2) continue;
    out.push({
      time: bars.at(-1)!.time,
      open: bars[0]!.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars.at(-1)!.close,
    });
  }
  return out;
}

const setups: Setup[] = [];
const quotesBy = new Map<string, Quote[]>();

for (const instrument of instruments) {
  let pip: number;
  try { pip = pipSizeFor(instrument as never); } catch { continue; }
  const h1 = (await query<Record<string, unknown>>(
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
  if (h1.length < 2000) continue;
  quotesBy.set(instrument, quotes);
  const d = toDaily(h1);
  const atr = calculateAtrValues(d as never, 14);
  const closes = d.map((c) => c.close);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));

  for (let i = 60; i < d.length; i += 1) {
    const bar = d[i]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    const a = atr[i]; const e21 = ema21[i]; const e50 = ema50[i];
    if (a == null || !(a > 0) || e21 == null || e50 == null) continue;
    const qi = qIndex.get(bar.time);
    if (qi == null) continue;
    const quote = quotes[qi]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || spreadPips > 5) continue;

    const w20 = d.slice(i - 20, i);
    const rh = Math.max(...w20.map((c) => c.high));
    const rl = Math.min(...w20.map((c) => c.low));
    const ret5 = (bar.close - d[i - 5]!.close) / a;
    const zWin = closes.slice(i - 19, i + 1);
    const zMean = zWin.reduce((s, v) => s + v, 0) / zWin.length;
    const zSd = Math.sqrt(zWin.reduce((s, v) => s + (v - zMean) ** 2, 0) / (zWin.length - 1));
    const z = zSd > 0 ? (bar.close - zMean) / zSd : 0;

    const push = (family: string, name: string, direction: "long" | "short", stop: number, targetR: number) => {
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      let s = stop;
      if (direction === "long" && entry - s < a * 0.8) s = entry - a;
      if (direction === "short" && s - entry < a * 0.8) s = entry + a;
      setups.push({ key: `${family}|${name}|${targetR}R`, family, instrument, ms: atMs, direction, entry, stop: s, qi, targetR });
    };

    if (bar.close > rh) push("breakout", "don20", "long", rl, 2);
    if (bar.close < rl) push("breakout", "don20", "short", rh, 2);
    if (ret5 >= 1.5 && e21 > e50) push("momentum", "thrust", "long", bar.close - a * 2, 2);
    if (ret5 <= -1.5 && e21 < e50) push("momentum", "thrust", "short", bar.close + a * 2, 2);
    if (z >= 2) push("meanrev", "zfade", "short", bar.close + a * 1.5, 1);
    if (z <= -2) push("meanrev", "zfade", "long", bar.close - a * 1.5, 1);
    if (e21 > e50 && bar.low <= e21 && bar.close > e21 && bar.close > bar.open) {
      push("ema", "pb", "long", Math.min(...d.slice(i - 5, i + 1).map((c) => c.low)), 2);
    }
    if (e21 < e50 && bar.high >= e21 && bar.close < e21 && bar.close < bar.open) {
      push("ema", "pb", "short", Math.max(...d.slice(i - 5, i + 1).map((c) => c.high)), 2);
    }
  }
  console.log(instrument, "d1 bars", d.length);
}

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
    // ~30 trading days of H1 forward
    const forward = quotes.slice(s.qi + 1, s.qi + 24 * 30);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { key, family: key.split("|")[0]!, n, avg: -999, verdict: "too few" as const, avgS: "-", ci: "-" };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  const verdict = n < 40 ? "too few" as const : hi < 0 ? "LOSES" as const : lo > 0 ? "WINS" as const : "no edge" as const;
  return { key, family: key.split("|")[0]!, n, avg: mean, verdict, avgS: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` };
}

const keys = [...new Set(setups.map((s) => s.key))];
const dev = keys.map((k) => simulate(k, REPLAY, HOLDOUT));
console.log("\n=== DEV ===");
console.table(dev.map(({ avg, ...r }) => ({ ...r, avg: r.avgS })));

console.log("\n=== HOLDOUT ===");
const wins: string[] = [];
for (const family of ["breakout", "momentum", "meanrev", "ema"]) {
  console.log(`\n# ${family}`);
  for (const row of dev.filter((d) => d.family === family)) {
    const h = simulate(row.key, HOLDOUT, null);
    if (h.verdict === "WINS") wins.push(row.key);
    console.log(`${row.key}: dev ${row.avgS} (n=${row.n}) → hold ${h.avgS} (${h.verdict}, n=${h.n}) ${h.ci}${h.verdict === "WINS" ? " ★★★" : ""}`);
  }
}
console.log("\nWINS:", wins.length ? wins.join(" | ") : "none");
process.exit(0);
