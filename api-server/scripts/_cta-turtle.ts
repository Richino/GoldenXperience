/**
 * CTA-style D1 turtle: N-day breakout, 2×ATR stop, ATR trail, no fixed target.
 * Expanded H1→D1 universe. Holdout sealed 2025-01-01.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2018-01-01T00:00:00Z");

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidHigh: number; bidLow: number; bidClose: number; askHigh: number; askLow: number; askClose: number };

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
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([, bars]) => {
    if (bars.length < 2) return [];
    return [{
      time: bars.at(-1)!.time,
      open: bars[0]!.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars.at(-1)!.close,
    }];
  });
}

type Trade = { ms: number; resultR: number; instrument: string; look: number; trail: number };

async function runVariant(look: number, stopAtr: number, trailAtr: number, fromMs: number, toMs: number | null): Promise<Trade[]> {
  const trades: Trade[] = [];
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
      `SELECT close_time, bid_high::float, bid_low::float, bid_close::float,
              ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`, [instrument],
    )).rows.map((r) => ({
      closeTime: new Date(r.close_time as string).toISOString(),
      bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), bidClose: Number(r.bid_close),
      askHigh: Number(r.ask_high), askLow: Number(r.ask_low), askClose: Number(r.ask_close),
    }));
    if (h1.length < 2000) continue;
    const d = toDaily(h1);
    const atr = calculateAtrValues(d as never, 20);
    const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
    let openUntil = 0;

    for (let i = look + 25; i < d.length; i += 1) {
      const bar = d[i]!;
      const atMs = Date.parse(bar.time);
      if (atMs < fromMs || (toMs !== null && atMs >= toMs) || atMs < openUntil) continue;
      const a = atr[i];
      if (a == null || !(a > 0)) continue;
      const qi = qIndex.get(bar.time);
      if (qi == null) continue;
      const quote = quotes[qi]!;
      const spreadPips = (quote.askClose - quote.bidClose) / pip;
      if (!(spreadPips > 0) || spreadPips > 5) continue;

      const prior = d.slice(i - look, i);
      const rh = Math.max(...prior.map((c) => c.high));
      const rl = Math.min(...prior.map((c) => c.low));
      let direction: "long" | "short" | null = null;
      if (bar.close > rh) direction = "long";
      if (bar.close < rl) direction = "short";
      if (!direction) continue;

      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      let stop = direction === "long" ? entry - a * stopAtr : entry + a * stopAtr;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;

      // Walk forward day-by-day using H1 quotes aggregated roughly by advancing ~24 H1 bars
      let peak = entry;
      let exitR: number | null = null;
      let exitMs = atMs;
      for (let day = 1; day <= 60; day += 1) {
        const from = qi + 1 + (day - 1) * 24;
        const to = qi + 1 + day * 24;
        const slice = quotes.slice(from, to);
        if (!slice.length) break;
        if (direction === "long") {
          const hi = Math.max(...slice.map((q) => q.bidHigh));
          const lo = Math.min(...slice.map((q) => q.bidLow));
          const close = slice.at(-1)!.bidClose;
          if (lo <= stop) { exitR = (stop - entry) / risk; exitMs = Date.parse(slice.find((q) => q.bidLow <= stop)?.closeTime ?? slice.at(-1)!.closeTime); break; }
          peak = Math.max(peak, hi);
          stop = Math.max(stop, peak - a * trailAtr);
          if (day === 60) { exitR = (close - entry) / risk; exitMs = Date.parse(slice.at(-1)!.closeTime); }
        } else {
          const hi = Math.max(...slice.map((q) => q.askHigh));
          const lo = Math.min(...slice.map((q) => q.askLow));
          const close = slice.at(-1)!.askClose;
          if (hi >= stop) { exitR = (entry - stop) / risk; exitMs = Date.parse(slice.find((q) => q.askHigh >= stop)?.closeTime ?? slice.at(-1)!.closeTime); break; }
          peak = Math.min(peak, lo);
          stop = Math.min(stop, peak + a * trailAtr);
          if (day === 60) { exitR = (entry - close) / risk; exitMs = Date.parse(slice.at(-1)!.closeTime); }
        }
      }
      if (exitR == null) continue;
      openUntil = exitMs;
      trades.push({ ms: atMs, resultR: exitR, instrument, look, trail: trailAtr });
    }
  }
  return trades;
}

function summarise(label: string, trades: Trade[]) {
  const n = trades.length;
  if (n < 2) return { label, n, avg: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = trades.reduce((s, t) => s + t.resultR, 0) / n;
  const se = Math.sqrt(trades.reduce((s, t) => s + (t.resultR - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    label, n, avg: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const VARIANTS = [
  { look: 20, stop: 2, trail: 3 },
  { look: 55, stop: 2, trail: 3 },
  { look: 20, stop: 2, trail: 2 },
  { look: 10, stop: 2, trail: 3 },
  { look: 55, stop: 3, trail: 4 },
];

console.log("=== DEV ===");
const dev = [];
for (const v of VARIANTS) {
  const label = `don${v.look} stop${v.stop} trail${v.trail}`;
  const trades = await runVariant(v.look, v.stop, v.trail, REPLAY, HOLDOUT);
  const row = summarise(label, trades);
  dev.push({ ...row, v });
  console.log(`${label}: n=${row.n} avg=${row.avg} ${row.verdict}`);
}

console.log("\n=== HOLDOUT ===");
let wins = false;
for (const row of [...dev].sort((a, b) => b._mean - a._mean)) {
  const hold = summarise(row.label, await runVariant(row.v.look, row.v.stop, row.v.trail, HOLDOUT, null));
  const mark = hold.verdict === "WINS" ? " ★★★" : "";
  if (hold.verdict === "WINS") wins = true;
  console.log(`${row.label}: dev ${row.avg} → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ${hold.ci}${mark}`);
}
console.log(wins ? "FOUND WINS" : "no WINS");
process.exit(0);
