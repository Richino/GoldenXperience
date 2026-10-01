/**
 * OLD NORMAL vs NEW NORMAL Analyze hierarchy, causal replay on OANDA candles.
 *
 *   A. LEGACY  H1 context · M15 primary regime (setup on M15 too)
 *   B. ROLES   H4 context · H1 primary regime · M15 setup (M5 is reported
 *              only and does not move levels, so it is not fetched here)
 *
 * Every completed M15 close, while a pair has no order or position for that
 * variant, analyzeMarket runs on candles that had closed by then. A trade
 * becomes an order: MARKET fills at the next open, limits fill at their price
 * on bid/ask, and a pending order cancels after the Analyze lifetime (4h) or
 * when price reaches the target first. Exits are stop or target on bid/ask,
 * stop first when one bar touches both; open trades are marked at the end.
 * No news filter (no historical calendar) and no time stop.
 *
 * It also scores the NEW hierarchy's reading of an M15 move against the H1
 * trend at every H1 close: within the next 2 days, did price close beyond
 * the H1 swing extreme (pullback, trend continued) or through the H1
 * structure level (trend failed, M15 was the reversal)?
 *
 *   npx tsx scripts/compare-normal-hierarchy.ts --days=180 --pairs=EUR_USD,GBP_USD
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { analyzeMarket, type MarketAnalysis } from "../../frontend/src/lib/strategy/market-analysis.js";
import { classifyMarketRegime, DEFAULT_REGIME_SETTINGS } from "../../frontend/src/lib/strategy/market-regime.js";
import type { NormalHierarchy, RoleTimeframe } from "../../frontend/src/lib/strategy/timeframe-roles.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
const DAYS = Number(arg("days") ?? 180);
const PAIRS = (arg("pairs") ?? "EUR_USD,GBP_USD,USD_JPY,USD_CHF,AUD_USD,USD_CAD,NZD_USD").split(",");
const VARIANTS: NormalHierarchy[] = ["LEGACY", "ROLES"];
/** Analyze NORMAL order lifetime (api-server pending-manual-entries.ts). */
const ORDER_LIFETIME_MS = 4 * 60 * 60_000;
/** Candles handed to the analyzer per timeframe; the regime reads the last 200. */
const SLICE = 260;
/** Forward window for the pullback-vs-reversal score: 2 days of M15. */
const OUTCOME_BARS = 192;

const MINUTE = 60_000;
const DURATION: Record<string, number> = { M15: 15 * MINUTE, H1: 60 * MINUTE, H4: 240 * MINUTE, D: 1440 * MINUTE };
/** Warm-up candles before the test window, per timeframe. */
const WARMUP: Record<string, number> = { M15: SLICE, H1: SLICE, H4: SLICE, D: SLICE };

type Bar = { open: number; close: number; time: string; mid: Candle; bid: ResearchCandle["bid"]; ask: ResearchCandle["ask"] };

async function fetchSeries(instrument: string, granularity: string, sinceMs: number): Promise<Bar[]> {
  const out: ResearchCandle[] = [];
  let to = Date.now();
  for (;;) {
    const batch = await getResearchCandles(instrument, granularity, 5000, { to: new Date(to).toISOString() });
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
    time: candle.time,
    mid: { time: candle.time, open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close, volume: candle.volume, complete: true },
    bid: candle.bid,
    ask: candle.ask,
  }));
}

/** Candles that had closed by `t`, newest last (bars are sorted by close). */
function closedBy(bars: Bar[], t: number): Candle[] {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.close <= t) lo = mid + 1; else hi = mid; }
  return bars.slice(Math.max(0, lo - SLICE), lo).map((bar) => bar.mid);
}

type Trade = { pair: string; long: boolean; placedAt: number; filledAt: number; exitAt: number; r: number; mae: number; mfe: number; exit: "stop" | "target" | "open" };
type Order = { long: boolean; entry: number; stop: number; target: number; market: boolean; placedAt: number };
type Position = Order & { fill: number; risk: number; filledAt: number; best: number; worst: number };

type Stats = { orders: number; trades: Trade[]; cancelled: number };

function simulate(pair: string, series: Record<string, Bar[]>, variant: NormalHierarchy, start: number, stats: Stats) {
  const m15 = series.M15!;
  const pip = pipSizeFor(pair);
  let order: Order | null = null;
  let position: Position | null = null;
  const close = (bar: Bar, price: number, exit: Trade["exit"]) => {
    const p = position!;
    const r = (p.long ? price - p.fill : p.fill - price) / p.risk;
    stats.trades.push({ pair, long: p.long, placedAt: p.placedAt, filledAt: p.filledAt, exitAt: bar.close, r, mae: p.worst, mfe: p.best, exit });
    position = null;
  };
  const track = (bar: Bar) => {
    const p = position!;
    const favourable = p.long ? bar.bid.high - p.fill : p.fill - bar.ask.low;
    const adverse = p.long ? p.fill - bar.bid.low : bar.ask.high - p.fill;
    p.best = Math.max(p.best, favourable / p.risk);
    p.worst = Math.max(p.worst, adverse / p.risk);
  };
  /** Stop first when a bar reaches both; `stopOnly` on the fill bar, whose order of events is unknown. */
  const checkExit = (bar: Bar, stopOnly: boolean) => {
    const p = position!;
    track(bar);
    const stopped = p.long ? bar.bid.low <= p.stop : bar.ask.high >= p.stop;
    if (stopped) return close(bar, p.stop, "stop");
    if (stopOnly) return;
    const hit = p.long ? bar.bid.high >= p.target : bar.ask.low <= p.target;
    if (hit) close(bar, p.target, "target");
  };

  for (let index = 0; index < m15.length; index += 1) {
    const bar = m15[index]!;
    if (position) checkExit(bar, false);
    else if (order) {
      const o: Order = order;
      const fillPrice = o.market ? (o.long ? bar.ask.open : bar.bid.open)
        : o.long ? (bar.ask.low <= o.entry ? Math.min(o.entry, bar.ask.open) : null)
          : (bar.bid.high >= o.entry ? Math.max(o.entry, bar.bid.open) : null);
      if (fillPrice !== null && bar.open < o.placedAt + ORDER_LIFETIME_MS) {
        const risk = Math.abs(fillPrice - o.stop);
        order = null;
        if (risk > 0 && (o.long ? fillPrice > o.stop : fillPrice < o.stop)) {
          position = { ...o, fill: fillPrice, risk, filledAt: bar.open, best: 0, worst: 0 };
          checkExit(bar, true);
        } else stats.cancelled += 1;
      } else if (bar.open >= o.placedAt + ORDER_LIFETIME_MS || (o.long ? bar.mid.high >= o.target : bar.mid.low <= o.target)) {
        order = null;
        stats.cancelled += 1;
      }
    }
    if (bar.close < start || position || order) continue;

    const t = bar.close;
    const analysis = analyzeMarket({
      instrument: pair,
      mode: "NORMAL",
      normalHierarchy: variant,
      candles: { M15: closedBy(m15, t), H1: closedBy(series.H1!, t), H4: closedBy(series.H4!, t), D1: closedBy(series.D!, t) } satisfies Partial<Record<RoleTimeframe, Candle[]>>,
      currentPrice: bar.mid.close,
      spreadPips: (bar.ask.close - bar.bid.close) / pip,
      now: t,
    });
    if (!analysis.trade || analysis.decision === "NO TRADE") continue;
    stats.orders += 1;
    order = {
      long: analysis.decision === "LONG",
      entry: analysis.trade.entry,
      stop: analysis.trade.stopLoss,
      target: analysis.trade.takeProfit,
      market: analysis.trade.orderType === "MARKET",
      placedAt: t,
    };
  }
  if (position) {
    const last = m15.at(-1)!;
    close(last, (position as Position).long ? last.bid.close : last.ask.close, "open");
  }
}

type PullbackScore = Record<"PULLBACK" | "CONTINUATION", { continued: number; failed: number; unresolved: number }>;

/** NEW hierarchy: was an M15 move against the H1 trend a pullback or the start of a reversal? */
function scorePullbacks(pair: string, series: Record<string, Bar[]>, start: number, score: PullbackScore) {
  const m15 = series.M15!;
  for (let index = 0; index < m15.length - 1; index += 1) {
    const t = m15[index]!.close;
    if (t < start || t % DURATION.H1! !== 0) continue;
    const h1 = closedBy(series.H1!, t);
    const analysis: MarketAnalysis = analyzeMarket({
      instrument: pair, mode: "NORMAL", normalHierarchy: "ROLES",
      candles: { M15: closedBy(m15, t), H1: h1, H4: closedBy(series.H4!, t) }, now: t,
    });
    const state = analysis.hierarchy.setup?.state;
    if ((analysis.regime !== "UPTREND" && analysis.regime !== "DOWNTREND") || (state !== "PULLBACK" && state !== "CONTINUATION")) continue;
    const read = classifyMarketRegime(h1, DEFAULT_REGIME_SETTINGS);
    const up = analysis.regime === "UPTREND";
    const extreme = up ? read.latestSwingHigh?.price : read.latestSwingLow?.price;
    const structure = read.impulse?.from.price;
    if (extreme === undefined || structure === undefined) continue;
    let outcome: "continued" | "failed" | "unresolved" = "unresolved";
    for (let ahead = index + 1; ahead < Math.min(m15.length, index + 1 + OUTCOME_BARS); ahead += 1) {
      const closePrice = m15[ahead]!.mid.close;
      if (up ? closePrice > extreme : closePrice < extreme) { outcome = "continued"; break; }
      if (up ? closePrice < structure : closePrice > structure) { outcome = "failed"; break; }
    }
    score[state][outcome] += 1;
  }
}

function summarize(trades: Trade[]) {
  const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  const wins = sorted.filter((trade) => trade.r > 0);
  const losses = sorted.filter((trade) => trade.r <= 0);
  const total = sorted.reduce((sum, trade) => sum + trade.r, 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.r, 0);
  const grossLoss = -losses.reduce((sum, trade) => sum + trade.r, 0);
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const trade of sorted) { equity += trade.r; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    trades: sorted.length,
    long: sorted.filter((trade) => trade.long).length,
    short: sorted.filter((trade) => !trade.long).length,
    winRate: sorted.length ? wins.length / sorted.length : 0,
    expectancy: sorted.length ? total / sorted.length : 0,
    totalR: total,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: drawdown,
    avgMae: mean(sorted.map((trade) => trade.mae)),
    avgMfe: mean(sorted.map((trade) => trade.mfe)),
    avgHoldHours: mean(sorted.map((trade) => (trade.exitAt - trade.filledAt) / 3_600_000)),
  };
}

async function main() {
  const start = Date.now() - DAYS * 86_400_000;
  const stats: Record<NormalHierarchy, Stats> = { LEGACY: { orders: 0, trades: [], cancelled: 0 }, ROLES: { orders: 0, trades: [], cancelled: 0 } };
  const perPair: Array<{ pair: string; variant: NormalHierarchy; summary: ReturnType<typeof summarize>; orders: number }> = [];
  const score: PullbackScore = { PULLBACK: { continued: 0, failed: 0, unresolved: 0 }, CONTINUATION: { continued: 0, failed: 0, unresolved: 0 } };

  for (const pair of PAIRS) {
    const series: Record<string, Bar[]> = {};
    for (const granularity of ["M15", "H1", "H4", "D"]) {
      series[granularity] = await fetchSeries(pair, granularity, start - WARMUP[granularity]! * DURATION[granularity]! * 1.6);
    }
    console.log(`${pair}: ${series.M15!.length} M15, ${series.H1!.length} H1, ${series.H4!.length} H4, ${series.D!.length} D1`);
    for (const variant of VARIANTS) {
      const pairStats: Stats = { orders: 0, trades: [], cancelled: 0 };
      simulate(pair, series, variant, start, pairStats);
      stats[variant].orders += pairStats.orders;
      stats[variant].cancelled += pairStats.cancelled;
      stats[variant].trades.push(...pairStats.trades);
      perPair.push({ pair, variant, summary: summarize(pairStats.trades), orders: pairStats.orders });
    }
    scorePullbacks(pair, series, start, score);
  }

  const fmt = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "inf";
  console.log(`\n=== NORMAL hierarchy comparison, last ${DAYS} days, ${PAIRS.length} pairs ===`);
  console.log("variant  setups  filled  cancel  long/short  win%   expR    totalR   PF     maxDD_R  MAE_R  MFE_R  hold_h");
  for (const variant of VARIANTS) {
    const s = summarize(stats[variant].trades);
    console.log(`${variant.padEnd(8)} ${String(stats[variant].orders).padStart(6)}  ${String(s.trades).padStart(6)}  ${String(stats[variant].cancelled).padStart(6)}  ${`${s.long}/${s.short}`.padStart(10)}  ${fmt(s.winRate * 100, 1).padStart(5)}  ${fmt(s.expectancy, 3).padStart(6)}  ${fmt(s.totalR, 1).padStart(7)}  ${fmt(s.profitFactor).padStart(5)}  ${fmt(s.maxDrawdownR, 1).padStart(7)}  ${fmt(s.avgMae).padStart(5)}  ${fmt(s.avgMfe).padStart(5)}  ${fmt(s.avgHoldHours, 1).padStart(6)}`);
  }
  console.log("\nper pair (filled trades, totalR, expR):");
  for (const row of perPair) {
    console.log(`  ${row.pair} ${row.variant.padEnd(6)} setups ${String(row.orders).padStart(4)}  trades ${String(row.summary.trades).padStart(4)}  totalR ${fmt(row.summary.totalR, 1).padStart(6)}  expR ${fmt(row.summary.expectancy, 3)}`);
  }
  console.log("\nNEW hierarchy, M15 move vs H1 trend, outcome within 2 days (sampled each H1 close):");
  for (const state of ["PULLBACK", "CONTINUATION"] as const) {
    const row = score[state];
    const resolved = row.continued + row.failed;
    console.log(`  M15 ${state.padEnd(12)} H1 continued ${row.continued}  H1 failed ${row.failed}  unresolved ${row.unresolved}  → continued ${resolved ? fmt((row.continued / resolved) * 100, 1) : "—"}% of resolved`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
