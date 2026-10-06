/**
 * Deliberate overfit of the H4-trend + M15-flip rule (user's request,
 * 2026-10-06), with an untouched holdout to show what the fit is worth.
 *
 * Every flip signal (see trend-flip-h4-m15.ts) is recorded with its features
 * and its bid/ask outcome at several reward multiples (stop first on a shared
 * bar, 5-day time stop). Signals are scored independently (overlap allowed).
 * The search sees only signals before FIT_END; the chosen rule set is then
 * replayed unchanged on everything after it.
 *
 *   npx tsx scripts/trend-flip-overfit.ts --days=1095
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { classifyMarketRegime, DEFAULT_REGIME_SETTINGS, type RegimeRead } from "../../frontend/src/lib/strategy/market-regime.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
const DAYS = Number(arg("days") ?? 1095);
const PAIRS = (arg("pairs") ?? "EUR_USD,GBP_USD,USD_JPY,USD_CHF,AUD_USD,USD_CAD,NZD_USD,EUR_JPY,EUR_GBP,GBP_JPY,AUD_JPY,CAD_JPY").split(",");
const FIT_END = Date.parse("2026-01-01T00:00:00Z");
const REWARDS = [1, 1.5, 2, 3, 4] as const;
const SLICE = 260;
const MINUTE = 60_000;
const DURATION: Record<string, number> = { M15: 15 * MINUTE, H4: 240 * MINUTE };
const TIME_STOP_MS = 5 * 86_400_000;

type Bar = { open: number; close: number; mid: Candle; bid: ResearchCandle["bid"]; ask: ResearchCandle["ask"] };
type Signal = { pair: string; t: number; hour: number; long: boolean; stopPips: number; spreadShare: number; h4Confidence: string; r: Record<number, number> };

async function fetchSeries(instrument: string, granularity: string, sinceMs: number): Promise<Bar[]> {
  const out: ResearchCandle[] = [];
  let to = Date.now() - 5 * MINUTE;
  for (;;) {
    let batch: ResearchCandle[] = [];
    for (let attempt = 1; ; attempt += 1) {
      try { batch = await getResearchCandles(instrument, granularity, 5000, { to: new Date(to).toISOString() }); break; }
      catch (error) { if (attempt >= 4) throw error; await new Promise((resolve) => setTimeout(resolve, 3000 * attempt)); }
    }
    if (!batch.length) break;
    out.push(...batch);
    const earliest = Math.min(...batch.map((candle) => Date.parse(candle.time)));
    if (earliest <= sinceMs || batch.length < 5000) break;
    to = earliest - 1;
  }
  const unique = new Map(out.filter((candle) => candle.complete).map((candle) => [Date.parse(candle.time), candle]));
  return [...unique.entries()].sort((a, b) => a[0] - b[0]).map(([open, candle]) => ({
    open,
    close: open + DURATION[granularity]!,
    mid: { time: candle.time, open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close, volume: candle.volume, complete: true },
    bid: candle.bid,
    ask: candle.ask,
  }));
}

function closedBy(bars: Bar[], t: number): Candle[] {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.close <= t) lo = mid + 1; else hi = mid; }
  return bars.slice(Math.max(0, lo - SLICE), lo).map((bar) => bar.mid);
}

/** R at each reward multiple for a trade filled at the open of m15[from]. */
function outcomes(m15: Bar[], from: number, long: boolean, stop: number): Record<number, number> | null {
  const bar = m15[from]!;
  const fill = long ? bar.ask.open : bar.bid.open;
  const risk = long ? fill - stop : stop - fill;
  if (!(risk > 0)) return null;
  const result: Record<number, number> = {};
  for (const reward of REWARDS) {
    const target = long ? fill + reward * risk : fill - reward * risk;
    let r: number | null = null;
    let index = from;
    for (; index < m15.length; index += 1) {
      const b = m15[index]!;
      if (long ? b.bid.low <= stop : b.ask.high >= stop) { r = -1; break; }
      if (long ? b.bid.high >= target : b.ask.low <= target) { r = reward; break; }
      if (b.close - bar.open >= TIME_STOP_MS) { r = ((long ? b.bid.close : b.ask.close) - fill) * (long ? 1 : -1) / risk; break; }
    }
    if (r === null) { const last = m15.at(-1)!; r = ((long ? last.bid.close : last.ask.close) - fill) * (long ? 1 : -1) / risk; }
    result[reward] = r;
  }
  return result;
}

function signalsFor(pair: string, m15: Bar[], h4: Bar[], start: number): Signal[] {
  const pip = pipSizeFor(pair);
  const out: Signal[] = [];
  let previous: RegimeRead | null = null;
  for (let index = 0; index < m15.length - 1; index += 1) {
    const bar = m15[index]!;
    const t = bar.close;
    if (t < start - 2 * DURATION.M15!) continue;
    const read = classifyMarketRegime(closedBy(m15, t), DEFAULT_REGIME_SETTINGS);
    const before = previous;
    previous = read;
    if (t < start || !before || !before.latestSwingHigh || !before.latestSwingLow) continue;
    const close = bar.mid.close;
    const shortFlip = before.regime === "UPTREND" && close < before.latestSwingLow.price;
    const longFlip = before.regime === "DOWNTREND" && close > before.latestSwingHigh.price;
    if (!shortFlip && !longFlip) continue;
    const overall = classifyMarketRegime(closedBy(h4, t), DEFAULT_REGIME_SETTINGS);
    if (shortFlip && overall.regime !== "DOWNTREND") continue;
    if (longFlip && overall.regime !== "UPTREND") continue;
    const long = longFlip;
    const spread = bar.ask.close - bar.bid.close;
    const buffer = spread + 0.1 * read.atr;
    const stop = long ? before.latestSwingLow.price - buffer : before.latestSwingHigh.price + buffer;
    const r = outcomes(m15, index + 1, long, stop);
    if (!r) continue;
    const next = m15[index + 1]!;
    const stopPips = Math.abs((long ? next.ask.open : next.bid.open) - stop) / pip;
    out.push({ pair, t, hour: new Date(t).getUTCHours(), long, stopPips, spreadShare: spread / pip / stopPips, h4Confidence: overall.confidence, r });
  }
  return out;
}

type Rule = { pairs: Set<string>; dir: "both" | "long" | "short"; hours: [number, number]; reward: number; maxSpreadShare: number; minStop: number; maxStop: number; h4High: boolean };

const passes = (rule: Rule, s: Signal) =>
  rule.pairs.has(s.pair)
  && (rule.dir === "both" || (rule.dir === "long") === s.long)
  && s.hour >= rule.hours[0] && s.hour < rule.hours[1]
  && s.spreadShare <= rule.maxSpreadShare
  && s.stopPips >= rule.minStop && s.stopPips < rule.maxStop
  && (!rule.h4High || s.h4Confidence === "HIGH");

function score(rule: Rule, signals: Signal[]) {
  const rs = signals.filter((s) => passes(rule, s)).map((s) => s.r[rule.reward]!);
  const n = rs.length;
  const total = rs.reduce((a, b) => a + b, 0);
  const mean = n ? total / n : 0;
  const se = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) / n) : 0;
  return { n, total, mean, se, win: n ? rs.filter((x) => x > 0).length / n : 0 };
}

async function main() {
  const start = Date.now() - DAYS * 86_400_000;
  const signals: Signal[] = [];
  for (const pair of PAIRS) {
    const m15 = await fetchSeries(pair, "M15", start - SLICE * DURATION.M15! * 1.6);
    const h4 = await fetchSeries(pair, "H4", start - SLICE * DURATION.H4! * 1.6);
    signals.push(...signalsFor(pair, m15, h4, start));
    console.error(`${pair} done`);
  }
  const fit = signals.filter((s) => s.t < FIT_END);
  const hold = signals.filter((s) => s.t >= FIT_END);
  console.log(`signals: ${signals.length} (fit ${fit.length} before 2026, holdout ${hold.length} in 2026)`);

  // Search: every combination of the knobs below, plus greedy pair selection
  // (keep only pairs that were positive in the fit for that combination).
  const hourWindows: Array<[number, number]> = [[0, 24], [0, 7], [7, 12], [12, 17], [7, 17], [17, 24], [7, 10], [12, 15], [13, 16]];
  const best: Array<{ rule: Rule; fit: ReturnType<typeof score> }> = [];
  for (const dir of ["both", "long", "short"] as const)
    for (const hours of hourWindows)
      for (const reward of REWARDS)
        for (const maxSpreadShare of [Infinity, 0.1, 0.07, 0.05, 0.03])
          for (const [minStop, maxStop] of [[0, 1e9], [10, 1e9], [15, 1e9], [20, 1e9], [30, 1e9], [10, 40], [15, 60]] as Array<[number, number]>)
            for (const h4High of [false, true]) {
              const base: Rule = { pairs: new Set(PAIRS), dir, hours, reward, maxSpreadShare, minStop, maxStop, h4High };
              const kept = PAIRS.filter((pair) => { const s = score({ ...base, pairs: new Set([pair]) }, fit); return s.n >= 5 && s.mean > 0; });
              if (!kept.length) continue;
              const rule = { ...base, pairs: new Set(kept) };
              const result = score(rule, fit);
              if (result.n >= 40) best.push({ rule, fit: result });
            }
  best.sort((a, b) => b.fit.total - a.fit.total);
  const describe = (rule: Rule) => `pairs ${[...rule.pairs].join(",")} | ${rule.dir} | ${rule.hours[0]}-${rule.hours[1]} UTC | 1:${rule.reward} | spread<=${Number.isFinite(rule.maxSpreadShare) ? `${rule.maxSpreadShare * 100}%` : "any"} of stop | stop ${rule.minStop}-${rule.maxStop >= 1e9 ? "+" : rule.maxStop}p | H4 ${rule.h4High ? "HIGH conf" : "any"}`;
  const fmt = (s: ReturnType<typeof score>) => `trades ${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(1).padStart(5)}%  expR ${s.mean.toFixed(3).padStart(7)} ±${s.se.toFixed(3)}  totalR ${s.total.toFixed(1).padStart(7)}`;
  console.log(`\ncombinations kept: ${best.length}\n`);
  console.log("TOP 10 BY FIT TOTAL R  →  same rule on unseen 2026");
  for (const { rule, fit: f } of best.slice(0, 10)) {
    console.log(describe(rule));
    console.log(`   FIT  2023-10..2025  ${fmt(f)}`);
    console.log(`   2026 HOLDOUT        ${fmt(score(rule, hold))}`);
  }
  const holdMeans = best.slice(0, 100).map(({ rule }) => score(rule, hold));
  const positive = holdMeans.filter((s) => s.n > 0 && s.mean > 0).length;
  console.log(`\nTop 100 fits on 2026: ${positive}/100 positive, mean holdout expR ${(holdMeans.reduce((a, s) => a + s.mean, 0) / holdMeans.length).toFixed(3)}, mean fit expR ${(best.slice(0, 100).reduce((a, b) => a + b.fit.mean, 0) / Math.min(100, best.length)).toFixed(3)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
