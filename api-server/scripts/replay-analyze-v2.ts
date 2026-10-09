/**
 * Analyze V2 historical replay on OANDA bid/ask candles.
 *
 * At every decision time (each M15 close for NORMAL, each H4 close for
 * SWING) analyzeV2 runs on candles that had closed by then, with the closing
 * bid/ask as the quote. Nothing reads ahead.
 *
 * Variants, each with its own one-position-per-pair book:
 *   V2_1       the live engine (v2.1): stop behind the trend's structure level
 *   V2_0       v2.0: stop behind the pullback extreme (3 ATR limit)
 *   V2_NO_LIQ  v2.1 with the liquidity check ignored (only with --liquidity=on)
 *   OLD        the previous engine (analyzeMarket, fixed 1:2, limit orders
 *              that cancel after its lifetime or when the target trades first)
 *
 * Execution: a V2 trade fills at the next M15 open on the ask (long) or bid
 * (short); exits on bid/ask, stop first when one bar reaches both, and only
 * the stop is checked on the fill bar. R uses the actual fill. No time stop;
 * trades still open at the end are marked to market. No news filter: there
 * is no historical calendar, so every analysis gets an empty calendar (V2's
 * live news block is NOT exercised). No commission or slippage.
 *
 * The 365-day replay (2026-10-09) was seen before v2.1 was chosen, so it is
 * in-sample for v2.1. Forward evidence is only what happens after the
 * freeze; score it with --since:
 *
 *   npx tsx scripts/replay-analyze-v2.ts --since=2026-10-09
 *   npx tsx scripts/replay-analyze-v2.ts --days=365 --pairs=EUR_USD,GBP_USD --modes=NORMAL
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2, v20Config, type AnalyzeMode } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { analyzeV2, type AnalysisResult } from "../../frontend/src/lib/strategy/analyze-v2/decide.js";
import { buildTradePlan } from "../../frontend/src/lib/strategy/analyze-v2/plan.js";
import { analyzeMarket } from "../../frontend/src/lib/strategy/market-analysis.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const DAYS = Number(args.days ?? 365);
/** Scoring starts here (YYYY-MM-DD); defaults to --days before now. */
const SINCE = args.since ? Date.parse(`${args.since}T00:00:00Z`) : null;
const PAIRS = (args.pairs ?? "EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,USD_CHF,NZD_USD").split(",") as MajorInstrument[];
const MODES = (args.modes ?? "NORMAL,SWING").split(",") as AnalyzeMode[];
const WITH_OLD = args.old !== "off";
const WITH_NO_LIQ = args.liquidity === "on";
const SLICE = 300;
const MINUTE = 60_000;
const DURATION: Record<string, number> = { M15: 15 * MINUTE, H1: 60 * MINUTE, H4: 240 * MINUTE, D: 1440 * MINUTE };
/** Old engine order lifetimes (market-regime-*-v1). */
const OLD_LIFETIME: Record<AnalyzeMode, number> = { NORMAL: 4 * 60 * MINUTE, SWING: 48 * 60 * MINUTE };

type Bar = { open: number; close: number; mid: Candle; bid: ResearchCandle["bid"]; ask: ResearchCandle["ask"] };

async function fetchSeries(instrument: string, granularity: string, sinceMs: number): Promise<Bar[]> {
  const out: ResearchCandle[] = [];
  let to = Date.now();
  for (;;) {
    const batch = await getResearchCandles(instrument as MajorInstrument, granularity, 5000, { to: new Date(to).toISOString() });
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

/** Index just past the last bar closed by `t`. */
function closedIndex(bars: Bar[], t: number) {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.close <= t) lo = mid + 1; else hi = mid; }
  return lo;
}
const closedBy = (bars: Bar[], t: number) => { const end = closedIndex(bars, t); return bars.slice(Math.max(0, end - SLICE), end).map((bar) => bar.mid); };

type Variant = "V2_1" | "V2_0" | "V2_NO_LIQ" | "OLD";
const VARIANTS: Variant[] = ["V2_1", "V2_0", ...(WITH_NO_LIQ ? ["V2_NO_LIQ" as const] : []), ...(WITH_OLD ? ["OLD" as const] : [])];

interface Trade {
  pair: string; mode: AnalyzeMode; variant: Variant; long: boolean;
  placedAt: number; filledAt: number; exitAt: number; r: number; mae: number; mfe: number;
  exit: "stop" | "target" | "open"; spreadShare: number; confirmed: boolean; liquidityRisk: string;
}
type Pending = { long: boolean; entry: number | null; stop: number; target: number; placedAt: number; expires: number; spreadShare: number; confirmed: boolean; liquidityRisk: string };
type Open = { long: boolean; fill: number; stop: number; target: number; risk: number; placedAt: number; filledAt: number; best: number; worst: number; spreadShare: number; confirmed: boolean; liquidityRisk: string };
interface Book { order: Pending | null; position: Open | null }

interface Funnel {
  evaluations: number;
  trending: number;
  states: Record<string, number>;
  triggered: number;
  qualified: number;
  /** First blocking check of every v2.1 evaluation that was not a trade. */
  firstBlocker: Record<string, number>;
  /** Every blocking check among confirmed triggers that were still rejected. */
  triggeredRejectedBy: Record<string, number>;
}

const bump = (record: Record<string, number>, key: string) => { record[key] = (record[key] ?? 0) + 1; };

function replayPairMode(pair: MajorInstrument, mode: AnalyzeMode, series: Record<string, Bar[]>, start: number, trades: Trade[], funnel: Funnel) {
  const config = ANALYZE_V2[mode];
  const pip = pipSizeFor(pair);
  const m15 = series.M15!;
  const books = Object.fromEntries(VARIANTS.map((variant) => [variant, { order: null, position: null } as Book])) as Record<Variant, Book>;
  const decisionTimes = new Set((mode === "NORMAL" ? m15 : series.H4!).filter((bar) => bar.close >= start).map((bar) => bar.close));

  const closePosition = (variant: Variant, bar: Bar, price: number, exit: Trade["exit"]) => {
    const p = books[variant].position!;
    trades.push({
      pair, mode, variant, long: p.long, placedAt: p.placedAt, filledAt: p.filledAt, exitAt: bar.close,
      r: (p.long ? price - p.fill : p.fill - price) / p.risk, mae: p.worst, mfe: p.best, exit,
      spreadShare: p.spreadShare, confirmed: p.confirmed, liquidityRisk: p.liquidityRisk,
    });
    books[variant].position = null;
  };
  const checkExit = (variant: Variant, bar: Bar, stopOnly: boolean) => {
    const p = books[variant].position!;
    p.best = Math.max(p.best, (p.long ? bar.bid.high - p.fill : p.fill - bar.ask.low) / p.risk);
    p.worst = Math.max(p.worst, (p.long ? p.fill - bar.bid.low : bar.ask.high - p.fill) / p.risk);
    if (p.long ? bar.bid.low <= p.stop : bar.ask.high >= p.stop) return closePosition(variant, bar, p.stop, "stop");
    if (stopOnly) return;
    if (p.long ? bar.bid.high >= p.target : bar.ask.low <= p.target) closePosition(variant, bar, p.target, "target");
  };

  for (const bar of m15) {
    // 1. Manage what is open, on this bar's bid/ask.
    for (const variant of VARIANTS) {
      const book = books[variant];
      if (book.position) { checkExit(variant, bar, false); continue; }
      const o = book.order;
      if (!o) continue;
      const fill = o.entry === null
        ? (o.long ? bar.ask.open : bar.bid.open)
        : o.long ? (bar.ask.low <= o.entry ? Math.min(o.entry, bar.ask.open) : null) : (bar.bid.high >= o.entry ? Math.max(o.entry, bar.bid.open) : null);
      if (fill !== null && bar.open < o.expires) {
        book.order = null;
        const risk = Math.abs(fill - o.stop);
        if (risk > 0 && (o.long ? fill > o.stop : fill < o.stop)) {
          book.position = { long: o.long, fill, stop: o.stop, target: o.target, risk, placedAt: o.placedAt, filledAt: bar.open, best: 0, worst: 0, spreadShare: o.spreadShare, confirmed: o.confirmed, liquidityRisk: o.liquidityRisk };
          checkExit(variant, bar, true);
        }
      } else if (bar.open >= o.expires || (o.long ? bar.mid.high >= o.target : bar.mid.low <= o.target)) {
        book.order = null;
      }
    }

    // 2. Decide at this bar's close.
    const t = bar.close;
    if (!decisionTimes.has(t)) continue;
    const flat = (variant: Variant) => VARIANTS.includes(variant) && !books[variant].position && !books[variant].order;
    if (!VARIANTS.some(flat)) continue;
    const candles = { M15: closedBy(m15, t), H1: closedBy(series.H1!, t), H4: closedBy(series.H4!, t), D1: closedBy(series.D!, t) };
    const quote = { bid: bar.bid.close, ask: bar.ask.close, time: new Date(t - 1000).toISOString() };
    const placeFrom = (variant: Variant, result: AnalysisResult, plan: { side: "LONG" | "SHORT"; stop: number; target: number; spreadShare: number }) => {
      const liquidity = result.liquidity.assessment;
      books[variant].order = {
        long: plan.side === "LONG", entry: null, stop: plan.stop, target: plan.target, placedAt: t, expires: t + 2 * DURATION.M15!,
        spreadShare: plan.spreadShare, confirmed: liquidity.confirmation !== null, liquidityRisk: liquidity.risk,
      };
    };

    // v2.1, the live engine; the funnel is counted on it.
    if (flat("V2_1") || flat("V2_NO_LIQ")) {
      const result = analyzeV2({ instrument: pair, mode, candles, quote, now: t, news: [] });
      funnel.evaluations += 1;
      if (result.marketStructure.primaryTrend === "UPTREND" || result.marketStructure.primaryTrend === "DOWNTREND") funnel.trending += 1;
      bump(funnel.states, result.setup.status);
      if (result.setup.status === "TRIGGERED") funnel.triggered += 1;
      const blocking = result.checks.filter((check) => check.evaluated && (check.status === "FAIL" || check.status === "UNKNOWN"));
      if (result.execution) funnel.qualified += 1;
      else {
        bump(funnel.firstBlocker, blocking[0]?.id ?? "none");
        if (result.setup.status === "TRIGGERED") for (const check of blocking) bump(funnel.triggeredRejectedBy, check.id);
      }
      if (flat("V2_1") && result.execution) placeFrom("V2_1", result, result.execution);
      if (flat("V2_NO_LIQ")) {
        const onlyLiquidity = blocking.length > 0 && blocking.every((check) => check.id === "liquidity");
        if (result.execution) placeFrom("V2_NO_LIQ", result, result.execution);
        else if (onlyLiquidity && result.foundation.primary && result.foundation.pullback && result.foundation.data.quote.executable) {
          const side = result.marketStructure.primaryTrend === "UPTREND" ? "LONG" : "SHORT";
          const outcome = buildTradePlan({ instrument: pair, side, quote: result.foundation.data.quote.executable, trend: result.foundation.primary, pullback: result.foundation.pullback, zones: result.foundation.zones, config });
          if (outcome.plan) placeFrom("V2_NO_LIQ", result, outcome.plan);
        }
      }
    }
    if (flat("V2_0")) {
      const result = analyzeV2({ instrument: pair, mode, candles, quote, now: t, news: [], config: v20Config(mode) });
      if (result.execution) placeFrom("V2_0", result, result.execution);
    }
    if (flat("OLD")) {
      const old = analyzeMarket({
        instrument: pair, mode, candles, currentPrice: bar.mid.close, spreadPips: (bar.ask.close - bar.bid.close) / pip, now: t,
      });
      if (old.trade && old.decision !== "NO TRADE") {
        books.OLD.order = {
          long: old.decision === "LONG", entry: old.trade.orderType === "MARKET" ? null : old.trade.entry, stop: old.trade.stopLoss, target: old.trade.takeProfit,
          placedAt: t, expires: t + OLD_LIFETIME[mode], spreadShare: (bar.ask.close - bar.bid.close) / pip / old.trade.stopPips, confirmed: false, liquidityRisk: "n/a",
        };
      }
    }
  }
  const last = m15.at(-1)!;
  for (const variant of VARIANTS) {
    const p = books[variant].position;
    if (p) closePosition(variant, last, p.long ? last.bid.close : last.ask.close, "open");
  }
}

function summarize(trades: Trade[]) {
  const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  const wins = sorted.filter((trade) => trade.r > 0);
  const total = sorted.reduce((sum, trade) => sum + trade.r, 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.r, 0);
  const grossLoss = -sorted.filter((trade) => trade.r <= 0).reduce((sum, trade) => sum + trade.r, 0);
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const trade of sorted) { equity += trade.r; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const n = sorted.length;
  const sd = n > 1 ? Math.sqrt(sorted.reduce((sum, trade) => sum + (trade.r - total / n) ** 2, 0) / (n - 1)) : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    /** Win rate needed to break even at this average win (losses ≈ −1R). */
    breakEvenWinRate: avgWin > 0 ? 1 / (1 + avgWin) : null,
    avgR: n ? total / n : 0,
    /** 95% interval half-width of avgR (normal approximation). */
    avgR95: n > 1 ? (1.96 * sd) / Math.sqrt(n) : null,
    /** avgR with the entry spread added back: roughly the result before costs. */
    grossR: n ? (total + sorted.reduce((sum, trade) => sum + trade.spreadShare, 0)) / n : 0,
    totalR: total,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: drawdown,
    stopOutRate: n ? sorted.filter((trade) => trade.exit === "stop").length / n : 0,
    avgSpreadShare: mean(sorted.map((trade) => trade.spreadShare)),
    avgHoldHours: mean(sorted.map((trade) => (trade.exitAt - trade.filledAt) / 3_600_000)),
  };
}

const fmt = (summary: ReturnType<typeof summarize>) =>
  `${String(summary.trades).padStart(4)} tr  WR ${(summary.winRate * 100).toFixed(1).padStart(5)}%${summary.breakEvenWinRate !== null ? ` (b/e ${(summary.breakEvenWinRate * 100).toFixed(0)}%)` : ""}  avg ${summary.avgR >= 0 ? "+" : ""}${summary.avgR.toFixed(3)}R${summary.avgR95 !== null ? ` ±${summary.avgR95.toFixed(3)}` : ""}  gross ${summary.grossR >= 0 ? "+" : ""}${summary.grossR.toFixed(3)}R  PF ${Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : "∞"}  DD ${summary.maxDrawdownR.toFixed(1)}R  stop ${(summary.stopOutRate * 100).toFixed(0)}%  spread ${(summary.avgSpreadShare * 100).toFixed(0)}%R  hold ${summary.avgHoldHours.toFixed(1)}h`;

async function main() {
  const end = Date.now();
  const start = SINCE ?? end - DAYS * 86_400_000;
  const days = Math.max(1, Math.round((end - start) / 86_400_000));
  const splits = { development: [start, start + 0.5 * (end - start)], validation: [start + 0.5 * (end - start), start + 0.75 * (end - start)], test: [start + 0.75 * (end - start), end] } as const;
  const trades: Trade[] = [];
  const funnels = Object.fromEntries(MODES.map((mode) => [mode, { evaluations: 0, trending: 0, states: {}, triggered: 0, qualified: 0, firstBlocker: {}, triggeredRejectedBy: {} }])) as Record<AnalyzeMode, Funnel>;
  for (const pair of PAIRS) {
    const series: Record<string, Bar[]> = {};
    for (const granularity of ["M15", "H1", "H4", "D"]) series[granularity] = await fetchSeries(pair, granularity, start - SLICE * DURATION[granularity]! * 1.6);
    for (const mode of MODES) {
      const began = Date.now();
      replayPairMode(pair, mode, series, start, trades, funnels[mode]);
      console.log(`${pair} ${mode}: done in ${((Date.now() - began) / 1000).toFixed(0)}s`);
    }
  }

  const lines: string[] = [];
  const log = (line = "") => { lines.push(line); console.log(line); };
  log(`\nAnalyze V2 replay · ${days} days from ${new Date(start).toISOString().slice(0, 10)} · ${PAIRS.join(", ")} · bid/ask fills · no news filter · no commission/slippage`);
  if (!SINCE || SINCE < Date.parse("2026-10-09T00:00:00Z")) log("NOTE: includes data seen before v2.1 was chosen (frozen 2026-10-09); v2.1 results here are in-sample, not evidence.");
  for (const mode of MODES) {
    const funnel = funnels[mode];
    log(`\n== ${mode} funnel (v2.1): ${funnel.evaluations} evaluations, ${funnel.trending} trending (${(funnel.trending / Math.max(1, funnel.evaluations) * 100).toFixed(1)}%), ${funnel.triggered} confirmed triggers, ${funnel.qualified} qualified`);
    log(`   pullback states: ${Object.entries(funnel.states).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join(", ")}`);
    log(`   first blocker: ${Object.entries(funnel.firstBlocker).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join(", ")}`);
    log(`   confirmed triggers rejected by: ${Object.entries(funnel.triggeredRejectedBy).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join(", ") || "—"}`);
    for (const variant of VARIANTS) {
      const set = trades.filter((trade) => trade.mode === mode && trade.variant === variant);
      log(`\n${mode} ${variant.padEnd(9)} all   ${fmt(summarize(set))}`);
      log(`${mode} ${variant.padEnd(9)} long  ${fmt(summarize(set.filter((trade) => trade.long)))}`);
      log(`${mode} ${variant.padEnd(9)} short ${fmt(summarize(set.filter((trade) => !trade.long)))}`);
      if (!SINCE) {
        for (const [name, [from, to]] of Object.entries(splits)) {
          log(`${mode} ${variant.padEnd(9)} ${name.slice(0, 5).padEnd(5)} ${fmt(summarize(set.filter((trade) => trade.placedAt >= from && trade.placedAt < to)))}`);
        }
      }
      if (variant === "V2_1") {
        log(`${mode} V2_1 sweep-confirmed    ${fmt(summarize(set.filter((trade) => trade.confirmed)))}`);
        for (const pair of PAIRS) log(`${mode} V2_1 ${pair.padEnd(11)}       ${fmt(summarize(set.filter((trade) => trade.pair === pair)))}`);
      }
    }
  }
  const outDir = path.resolve(process.cwd(), "research-v2/analyze-v2");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${new Date().toISOString().slice(0, 10)}${SINCE ? `-since-${args.since}` : `-${DAYS}d`}-v2.1`;
  fs.writeFileSync(path.join(outDir, `replay-${stamp}.txt`), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, `replay-${stamp}.json`), JSON.stringify({ since: new Date(start).toISOString(), days, pairs: PAIRS, modes: MODES, variants: VARIANTS, funnels, trades }));
  console.log(`\nSaved to research-v2/analyze-v2/replay-${stamp}.{txt,json}`);
}

await main();
