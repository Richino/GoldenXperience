/**
 * Swing backtest, 2022-01-01 → now, EUR/USD H4.
 * Entry: HTF trend agrees with structure.
 *   HTF trend  = D1 EMA20 > EMA50 (or reverse) with agreeing slope.
 *   Structure  = last 2 pivot highs & lows both higher (or lower).
 *   Both must agree on direction.
 * Cooldown: 6 H4 bars (~1 day) between trades.
 * Exit: 1.5 ATR stop, 3.0 ATR target (ATR-14 on H4), 18-bar (72h) time-stop.
 *
 * Uses OANDA H4/D1 candles, paginated backwards until 2022-01-01.
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { calculateEmaValues, calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const INSTRUMENT = "EUR_USD" as const;
const START = Date.parse("2022-01-01T00:00:00Z");

const H4_MS = 4 * 60 * 60_000;
const HORIZON_BARS = 18; // 72h
const STOP_ATR = 1.5;
const TARGET_ATR = 3.0;
const COOLDOWN_BARS = 6;
const WARMUP_BARS = 260; // for D1 EMA50 + resample warmup

type Bar = {
  timeMs: number;
  time: string;
  midCandle: Candle;
  bidHigh: number; bidLow: number; bidClose: number;
  askHigh: number; askLow: number; askClose: number;
};

async function fetchAllH4(instrument: string, sinceMs: number): Promise<ResearchCandle[]> {
  const out: ResearchCandle[] = [];
  let toMs = Date.now() - 60_000;
  const perCall = 5000;
  while (true) {
    const batch = await getResearchCandles(instrument as any, "H4", perCall, { to: new Date(toMs).toISOString() });
    if (batch.length === 0) break;
    out.push(...batch);
    const earliest = Math.min(...batch.map((c) => Date.parse(c.time)));
    console.log(`  fetched ${batch.length} back to ${new Date(earliest).toISOString()} (running total ${out.length})`);
    if (earliest <= sinceMs || batch.length < perCall) break;
    toMs = earliest - 1;
  }
  const dedup = new Map<number, ResearchCandle>();
  for (const c of out) dedup.set(Date.parse(c.time), c);
  return [...dedup.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function toBars(raw: ResearchCandle[]): Bar[] {
  return raw.filter((c) => c.complete).map((c) => ({
    timeMs: Date.parse(c.time),
    time: c.time,
    midCandle: { time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: c.volume, complete: true },
    bidHigh: c.bid.high, bidLow: c.bid.low, bidClose: c.bid.close,
    askHigh: c.ask.high, askLow: c.ask.low, askClose: c.ask.close,
  }));
}

function resampleToD1(h4: Candle[]): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of h4) {
    const t = Date.parse(c.time);
    const dayStart = t - (t % (24 * 60 * 60_000));
    const arr = buckets.get(dayStart) ?? [];
    arr.push(c);
    buckets.set(dayStart, arr);
  }
  const out: Candle[] = [];
  for (const [day, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < 5) continue;
    group.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    out.push({
      time: new Date(day).toISOString(),
      open: group[0]!.open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group.at(-1)!.close,
      volume: 0,
      complete: true,
    });
  }
  return out;
}

function htfBias(d1: Candle[]): "long" | "short" | "undecided" {
  if (d1.length < 55) return "undecided";
  const closes = d1.map((c) => c.close);
  const ema20 = calculateEmaValues(closes, 20);
  const ema50 = calculateEmaValues(closes, 50);
  const atr = calculateAtrValues(d1, 14).at(-1);
  const fast = ema20.at(-1); const slow = ema50.at(-1);
  const fastPrev = ema20.at(-4);
  if (fast == null || slow == null || fastPrev == null || !(atr && atr > 0)) return "undecided";
  const gapAtr = (fast - slow) / atr;
  const slope = fast - fastPrev;
  if (gapAtr > 0.15 && slope > 0) return "long";
  if (gapAtr < -0.15 && slope < 0) return "short";
  return "undecided";
}

function structure(h4Window: Candle[]): "long" | "short" | "undecided" {
  if (h4Window.length < 30) return "undecided";
  const n = 3;
  const highs: number[] = []; const lows: number[] = [];
  for (let i = n; i < h4Window.length - n; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= n; k++) {
      if (h4Window[i - k]!.high >= h4Window[i]!.high || h4Window[i + k]!.high >= h4Window[i]!.high) isHigh = false;
      if (h4Window[i - k]!.low <= h4Window[i]!.low || h4Window[i + k]!.low <= h4Window[i]!.low) isLow = false;
    }
    if (isHigh) highs.push(h4Window[i]!.high);
    if (isLow) lows.push(h4Window[i]!.low);
  }
  if (highs.length < 2 || lows.length < 2) return "undecided";
  const hh = highs.at(-1)! > highs.at(-2)!;
  const hl = lows.at(-1)! > lows.at(-2)!;
  const lh = highs.at(-1)! < highs.at(-2)!;
  const ll = lows.at(-1)! < lows.at(-2)!;
  if (hh && hl) return "long";
  if (lh && ll) return "short";
  return "undecided";
}

function simulate(direction: "long" | "short", entry: number, atr: number, future: Bar[]) {
  const target = direction === "long" ? entry + TARGET_ATR * atr : entry - TARGET_ATR * atr;
  const stop = direction === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
  for (const bar of future) {
    const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return { hit: "stop" as const, r: -1 };
    if (targetHit) return { hit: "target" as const, r: TARGET_ATR / STOP_ATR };
    if (stopHit) return { hit: "stop" as const, r: -1 };
  }
  const last = future.at(-1);
  if (!last) return { hit: "no_data" as const, r: 0 };
  const finalPx = direction === "long" ? last.bidClose : last.askClose;
  return { hit: "timeout" as const, r: ((direction === "long" ? finalPx - entry : entry - finalPx)) / (STOP_ATR * atr) };
}

async function main() {
  console.log(`fetching ${INSTRUMENT} H4 candles back to ${new Date(START).toISOString()}...`);
  const raw = await fetchAllH4(INSTRUMENT, START);
  const bars = toBars(raw).filter((b) => b.timeMs >= START - 100 * H4_MS);
  console.log(`have ${bars.length} H4 bars, ${bars.at(0)?.time} → ${bars.at(-1)?.time}`);

  const trades: Array<{
    time: string; year: number; direction: "long" | "short"; hit: string; r: number; atr: number;
  }> = [];
  let cooldownUntil = -1;
  const counts = { evaluated: 0, htf_undecided: 0, struct_undecided: 0, disagree: 0, agree_take: 0, cooldown_skipped: 0 };

  for (let i = WARMUP_BARS; i < bars.length - HORIZON_BARS; i++) {
    const bar = bars[i]!;
    if (bar.timeMs < START) continue;
    counts.evaluated++;

    // Build D1 series from bars[0..i]
    const midHistory = bars.slice(0, i + 1).map((b) => b.midCandle);
    const d1 = resampleToD1(midHistory);
    const htf = htfBias(d1);
    if (htf === "undecided") { counts.htf_undecided++; continue; }

    const structureWindow = midHistory.slice(-40);
    const struct = structure(structureWindow);
    if (struct === "undecided") { counts.struct_undecided++; continue; }
    if (struct !== htf) { counts.disagree++; continue; }

    if (i < cooldownUntil) { counts.cooldown_skipped++; continue; }

    const atr = calculateAtrValues(midHistory, 14).at(-1);
    if (!(atr && atr > 0)) continue;

    counts.agree_take++;
    cooldownUntil = i + COOLDOWN_BARS;
    const direction = htf;
    const entry = direction === "long" ? bar.askClose : bar.bidClose;
    const future = bars.slice(i + 1, i + 1 + HORIZON_BARS);
    const outcome = simulate(direction, entry, atr, future);
    trades.push({
      time: bar.time, year: new Date(bar.timeMs).getUTCFullYear(),
      direction, hit: outcome.hit, r: outcome.r, atr,
    });
  }

  console.log("\n=== FILTER FUNNEL ===");
  console.table(counts);

  const wins = trades.filter((t) => t.hit === "target").length;
  const losses = trades.filter((t) => t.hit === "stop").length;
  const timeouts = trades.filter((t) => t.hit === "timeout").length;
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  console.log("\n=== OVERALL 2022-2026 SWING RESULT ===");
  console.table({
    trades: trades.length,
    wins, losses, timeouts,
    win_pct_excl_timeouts: wins + losses ? ((wins / (wins + losses)) * 100).toFixed(1) : "n/a",
    hit_pct_all: trades.length ? ((wins / trades.length) * 100).toFixed(1) : "n/a",
    sum_R: sumR.toFixed(2),
    avg_R: trades.length ? (sumR / trades.length).toFixed(3) : "n/a",
  });

  // Per-year breakdown
  const years = [...new Set(trades.map((t) => t.year))].sort();
  const perYear = years.map((y) => {
    const yr = trades.filter((t) => t.year === y);
    const w = yr.filter((t) => t.hit === "target").length;
    const l = yr.filter((t) => t.hit === "stop").length;
    const to = yr.filter((t) => t.hit === "timeout").length;
    const s = yr.reduce((s, t) => s + t.r, 0);
    return {
      year: y, n: yr.length, wins: w, losses: l, timeouts: to,
      win_pct_excl_to: w + l ? ((w / (w + l)) * 100).toFixed(1) : "n/a",
      sum_R: s.toFixed(2), avg_R: (s / yr.length).toFixed(3),
    };
  });
  console.log("\n=== PER YEAR ===");
  console.table(perYear);

  // Direction breakdown
  const longs = trades.filter((t) => t.direction === "long");
  const shorts = trades.filter((t) => t.direction === "short");
  console.log("\n=== BY DIRECTION ===");
  console.table([
    { dir: "long", n: longs.length, sum_R: longs.reduce((s, t) => s + t.r, 0).toFixed(2), avg_R: longs.length ? (longs.reduce((s, t) => s + t.r, 0) / longs.length).toFixed(3) : "n/a" },
    { dir: "short", n: shorts.length, sum_R: shorts.reduce((s, t) => s + t.r, 0).toFixed(2), avg_R: shorts.length ? (shorts.reduce((s, t) => s + t.r, 0) / shorts.length).toFixed(3) : "n/a" },
  ]);
}
main().catch((e) => { console.error(e); process.exit(1); });
