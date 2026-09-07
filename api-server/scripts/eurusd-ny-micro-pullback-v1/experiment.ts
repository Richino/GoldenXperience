/**
 * EUR/USD New York micro-pullback continuation V1.
 *
 * Isolated research only. Uses completed H1/M5 candles, next-M5-open entries,
 * historical bid/ask execution, explicit slippage, and no future information.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNewsTimes, nearestNewsMinutes, type RawBar } from "../eurusd-neural-day-v1/experiment.js";

type Bar = RawBar & { t: number };
type Direction = 1 | -1;
type Config = {
  name: string;
  minimumImpulseAtr: number;
  maximumRetracement: number;
  maximumHoldMinutes: 60 | 90;
};
type Signal = {
  decisionIndex: number;
  entryTime: string;
  day: string;
  direction: Direction;
  score: number;
  impulseAtr: number;
  retracement: number;
  pullbackBars: number;
  impulseBars: number;
  stopDistance: number;
  stopAtr: number;
  spreadAtr: number;
  newsDistanceMinutes: number | null;
};
type Trade = Signal & {
  exitTime: string;
  resultR: number;
  outcome: "TARGET" | "STOP" | "TIME_EXIT";
  holdMinutes: number;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-ny-micro-pullback-v1");
const M5_FILE = path.join(ROOT, "backtest-breakout-m5", "candles", "EUR_USD_M5.json");
const H1_FILE = path.join(ROOT, "backtest-legacy-expanded", "candles", "EUR_USD_H1.json");
const DEVELOPMENT = { from: Date.parse("2024-08-01T00:00:00Z"), to: Date.parse("2025-08-01T00:00:00Z") };
const HISTORICAL_CHECK = { from: Date.parse("2025-08-01T00:00:00Z"), to: Date.parse("2026-08-01T00:00:00Z") };
const PIP = 0.0001;
const ENTRY_SLIPPAGE_PIPS = 0.1;
const EXIT_SLIPPAGE_PIPS = 0.1;
const NEWS_BLACKOUT_MINUTES = 60;
const MAX_SPREAD_ATR = 0.30;
const MIN_STOP_ATR = 0.30;
const MAX_STOP_ATR = 1.25;
const MIN_STOP_PIPS = 3;
const MAX_TRADES_PER_DAY = 2;
const CONFIGS: Config[] = [];
for (const minimumImpulseAtr of [0.6, 0.8, 1.0]) {
  for (const maximumRetracement of [0.5, 0.65]) {
    for (const maximumHoldMinutes of [60, 90] as const) {
      CONFIGS.push({
        name: `impulse-${minimumImpulseAtr}-retrace-${maximumRetracement}-hold-${maximumHoldMinutes}`,
        minimumImpulseAtr,
        maximumRetracement,
        maximumHoldMinutes,
      });
    }
  }
}

const nyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function loadBars(file: string) {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { bars: RawBar[] };
  const deduplicated = new Map<number, Bar>();
  for (const raw of parsed.bars) {
    const t = Date.parse(raw.closeTime);
    if (Number.isFinite(t)) deduplicated.set(t, { ...raw, t });
  }
  return [...deduplicated.values()].sort((left, right) => left.t - right.t);
}

function nyParts(time: number) {
  const values = Object.fromEntries(nyFormatter.formatToParts(new Date(time))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function inEntryWindow(time: number) {
  const local = nyParts(time);
  const minutes = local.hour * 60 + local.minute;
  return minutes >= 8 * 60 && minutes <= 11 * 60 + 25;
}

function ema(values: number[], period: number) {
  const output = new Float64Array(values.length);
  const alpha = 2 / (period + 1);
  for (let index = 0; index < values.length; index += 1) {
    output[index] = index ? alpha * values[index]! + (1 - alpha) * output[index - 1]! : values[index]!;
  }
  return output;
}

function atr(bars: Bar[], period: number) {
  const output = new Float64Array(bars.length);
  output.fill(Number.NaN);
  const tr = new Float64Array(bars.length);
  let sum = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const previous = index ? bars[index - 1]!.close : bars[index]!.open;
    tr[index] = Math.max(bars[index]!.high - bars[index]!.low, Math.abs(bars[index]!.high - previous), Math.abs(bars[index]!.low - previous));
    sum += tr[index]!;
    if (index >= period) sum -= tr[index - period]!;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

function completedH1Index(h1: Bar[], time: number) {
  let low = 0;
  let high = h1.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (h1[middle]!.t <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function h1Direction(h1: Bar[], ema20: Float64Array, ema50: Float64Array, time: number): Direction | 0 {
  const index = completedH1Index(h1, time);
  if (index < 4) return 0;
  const close = h1[index]!.close;
  if (close > ema20[index]! && ema20[index]! > ema50[index]! && ema20[index]! > ema20[index - 3]!) return 1;
  if (close < ema20[index]! && ema20[index]! < ema50[index]! && ema20[index]! < ema20[index - 3]!) return -1;
  return 0;
}

function strongestPattern(
  bars: Bar[],
  atr14: Float64Array,
  h1: Bar[],
  h1Ema20: Float64Array,
  h1Ema50: Float64Array,
  index: number,
  config: Config,
) {
  const direction = h1Direction(h1, h1Ema20, h1Ema50, bars[index]!.t);
  if (!direction) return null;
  const currentAtr = atr14[index]!;
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;
  let best: Omit<Signal, "entryTime" | "day" | "spreadAtr" | "newsDistanceMinutes" | "decisionIndex"> | null = null;

  for (let pullbackBars = 1; pullbackBars <= 4; pullbackBars += 1) {
    const pullbackStart = index - pullbackBars;
    const impulseEnd = pullbackStart - 1;
    if (impulseEnd < 10) continue;
    for (let impulseBars = 2; impulseBars <= 5; impulseBars += 1) {
      const impulseStart = impulseEnd - impulseBars + 1;
      if (impulseStart < 1) continue;
      const impulseMove = direction === 1
        ? bars[impulseEnd]!.close - bars[impulseStart]!.open
        : bars[impulseStart]!.open - bars[impulseEnd]!.close;
      const impulseAtr = impulseMove / atr14[impulseEnd]!;
      if (!Number.isFinite(impulseAtr) || impulseAtr < config.minimumImpulseAtr) continue;

      let directionalBars = 0;
      for (let cursor = impulseStart; cursor <= impulseEnd; cursor += 1) {
        const body = bars[cursor]!.close - bars[cursor]!.open;
        if ((direction === 1 && body > 0) || (direction === -1 && body < 0)) directionalBars += 1;
      }
      if (directionalBars / impulseBars < 0.6) continue;

      const pullback = bars.slice(pullbackStart, index);
      if (!pullback.length) continue;
      const impulseClose = bars[impulseEnd]!.close;
      const pullbackExtreme = direction === 1
        ? Math.min(...pullback.map((bar) => bar.low))
        : Math.max(...pullback.map((bar) => bar.high));
      const retracement = direction === 1
        ? (impulseClose - pullbackExtreme) / impulseMove
        : (pullbackExtreme - impulseClose) / impulseMove;
      if (retracement < 0.15 || retracement > config.maximumRetracement) continue;
      const contraryBar = pullback.some((bar) => direction === 1 ? bar.close < bar.open : bar.close > bar.open);
      if (!contraryBar) continue;

      const breakLevel = direction === 1
        ? Math.max(...pullback.map((bar) => bar.high))
        : Math.min(...pullback.map((bar) => bar.low));
      const decision = bars[index]!;
      const brokeStructure = direction === 1 ? decision.close > breakLevel : decision.close < breakLevel;
      const confirmingBody = direction === 1 ? decision.close > decision.open : decision.close < decision.open;
      if (!brokeStructure || !confirmingBody) continue;
      const chaseAtr = Math.abs(decision.close - breakLevel) / currentAtr;
      if (chaseAtr > 0.25) continue;

      const entryBar = bars[index + 1]!;
      const entrySlip = ENTRY_SLIPPAGE_PIPS * PIP;
      const entry = direction === 1 ? entryBar.askOpen + entrySlip : entryBar.bidOpen - entrySlip;
      const stopBuffer = 0.05 * currentAtr;
      const stop = direction === 1 ? pullbackExtreme - stopBuffer : pullbackExtreme + stopBuffer;
      const stopDistance = Math.abs(entry - stop);
      const stopAtr = stopDistance / currentAtr;
      if (stopDistance < MIN_STOP_PIPS * PIP || stopAtr < MIN_STOP_ATR || stopAtr > MAX_STOP_ATR) continue;

      const score = impulseAtr - 0.6 * retracement - 0.4 * chaseAtr;
      if (!best || score > best.score) {
        best = { direction, score, impulseAtr, retracement, pullbackBars, impulseBars, stopDistance, stopAtr };
      }
    }
  }
  return best;
}

function buildSignals(
  bars: Bar[],
  h1: Bar[],
  newsTimes: number[],
  config: Config,
  period: { from: number; to: number },
) {
  const atr14 = atr(bars, 14);
  const h1Ema20 = ema(h1.map((bar) => bar.close), 20);
  const h1Ema50 = ema(h1.map((bar) => bar.close), 50);
  const signals: Signal[] = [];
  for (let index = 60; index < bars.length - 20; index += 1) {
    const decision = bars[index]!;
    if (decision.t < period.from || decision.t >= period.to || !inEntryWindow(decision.t)) continue;
    const pattern = strongestPattern(bars, atr14, h1, h1Ema20, h1Ema50, index, config);
    if (!pattern) continue;
    const entry = bars[index + 1]!;
    const currentAtr = atr14[index]!;
    const spreadAtr = (entry.askOpen - entry.bidOpen) / currentAtr;
    const newsDistanceMinutes = nearestNewsMinutes(newsTimes, decision.t);
    if (spreadAtr > MAX_SPREAD_ATR || (newsDistanceMinutes != null && newsDistanceMinutes <= NEWS_BLACKOUT_MINUTES)) continue;
    signals.push({
      decisionIndex: index,
      entryTime: new Date(decision.t).toISOString(),
      day: nyParts(decision.t).day,
      ...pattern,
      spreadAtr,
      newsDistanceMinutes,
    });
  }
  return signals;
}

function resolve(bars: Bar[], signal: Signal, maximumHoldMinutes: number) {
  const entryIndex = signal.decisionIndex + 1;
  const entryBar = bars[entryIndex]!;
  const entrySlip = ENTRY_SLIPPAGE_PIPS * PIP;
  const exitSlip = EXIT_SLIPPAGE_PIPS * PIP;
  const entry = signal.direction === 1 ? entryBar.askOpen + entrySlip : entryBar.bidOpen - entrySlip;
  const stop = signal.direction === 1 ? entry - signal.stopDistance : entry + signal.stopDistance;
  const target = signal.direction === 1 ? entry + 2 * signal.stopDistance : entry - 2 * signal.stopDistance;
  const maxBars = maximumHoldMinutes / 5;
  let exitIndex = entryIndex;
  for (let cursor = entryIndex; cursor <= Math.min(entryIndex + maxBars - 1, bars.length - 1); cursor += 1) {
    exitIndex = cursor;
    const bar = bars[cursor]!;
    const stopHit = signal.direction === 1 ? bar.bidLow <= stop : bar.askHigh >= stop;
    const targetHit = signal.direction === 1 ? bar.bidHigh >= target : bar.askLow <= target;
    if (stopHit) {
      const fill = signal.direction === 1 ? stop - exitSlip : stop + exitSlip;
      const move = signal.direction === 1 ? fill - entry : entry - fill;
      return { outcome: "STOP" as const, resultR: 0.75 * move / signal.stopDistance, exitTime: bar.t, holdMinutes: (bar.t - bars[signal.decisionIndex]!.t) / 60_000 };
    }
    if (targetHit) {
      const fill = signal.direction === 1 ? target - exitSlip : target + exitSlip;
      const move = signal.direction === 1 ? fill - entry : entry - fill;
      return { outcome: "TARGET" as const, resultR: 0.75 * move / signal.stopDistance, exitTime: bar.t, holdMinutes: (bar.t - bars[signal.decisionIndex]!.t) / 60_000 };
    }
  }
  const exitBar = bars[exitIndex]!;
  const fill = signal.direction === 1 ? exitBar.bidClose - exitSlip : exitBar.askClose + exitSlip;
  const move = signal.direction === 1 ? fill - entry : entry - fill;
  return {
    outcome: "TIME_EXIT" as const,
    resultR: Math.max(-0.8, Math.min(1.5, 0.75 * move / signal.stopDistance)),
    exitTime: exitBar.t,
    holdMinutes: (exitBar.t - bars[signal.decisionIndex]!.t) / 60_000,
  };
}

function replay(bars: Bar[], signals: Signal[], config: Config) {
  const trades: Trade[] = [];
  const perDay = new Map<string, number>();
  let lockedUntil = -Infinity;
  for (const signal of signals.sort((left, right) => Date.parse(left.entryTime) - Date.parse(right.entryTime))) {
    const time = Date.parse(signal.entryTime);
    if (time < lockedUntil || (perDay.get(signal.day) ?? 0) >= MAX_TRADES_PER_DAY) continue;
    const outcome = resolve(bars, signal, config.maximumHoldMinutes);
    trades.push({ ...signal, ...outcome, exitTime: new Date(outcome.exitTime).toISOString() });
    perDay.set(signal.day, (perDay.get(signal.day) ?? 0) + 1);
    lockedUntil = outcome.exitTime;
  }
  return trades;
}

function marketDays(bars: Bar[], period: { from: number; to: number }) {
  const days = new Set<string>();
  for (const bar of bars) if (bar.t >= period.from && bar.t < period.to && inEntryWindow(bar.t)) days.add(nyParts(bar.t).day);
  return days.size;
}

function summarize(trades: Trade[], days: number) {
  const profitable = trades.filter((trade) => trade.resultR > 0).length;
  const targets = trades.filter((trade) => trade.outcome === "TARGET").length;
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossWin = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  const monthReturns = new Map<string, number>();
  for (const trade of trades) {
    equity += trade.resultR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    const month = trade.entryTime.slice(0, 7);
    monthReturns.set(month, (monthReturns.get(month) ?? 0) + trade.resultR);
  }
  const mean = totalR / Math.max(1, trades.length);
  const variance = trades.length > 1
    ? trades.reduce((sum, trade) => sum + (trade.resultR - mean) ** 2, 0) / (trades.length - 1)
    : 0;
  const standardError = Math.sqrt(variance / Math.max(1, trades.length));
  return {
    trades: trades.length,
    marketDays: days,
    tradesPerMarketDay: trades.length / Math.max(1, days),
    profitableTrades: profitable,
    profitableRate: profitable / Math.max(1, trades.length),
    targets,
    targetRate: targets / Math.max(1, trades.length),
    totalR,
    expectancyR: mean,
    expectancy95: { lower: mean - 1.96 * standardError, upper: mean + 1.96 * standardError },
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR,
    positiveMonths: [...monthReturns.values()].filter((value) => value > 0).length,
    activeMonths: monthReturns.size,
    averageHoldMinutes: trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / Math.max(1, trades.length),
    stops: trades.filter((trade) => trade.outcome === "STOP").length,
    timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length,
    longs: trades.filter((trade) => trade.direction === 1).length,
    shorts: trades.filter((trade) => trade.direction === -1).length,
  };
}

function select(rows: Array<{ config: Config; trades: Trade[]; summary: ReturnType<typeof summarize> }>) {
  const qualified = rows.filter((row) => row.summary.trades >= 80
    && row.summary.expectancyR > 0
    && row.summary.profitFactor > 1
    && row.summary.positiveMonths >= Math.ceil(row.summary.activeMonths * 0.55));
  const adequate = rows.filter((row) => row.summary.trades >= 80);
  const pool = qualified.length ? qualified : adequate.length ? adequate : rows;
  return [...pool].sort((left, right) => {
    const leftRobust = left.summary.expectancy95.lower;
    const rightRobust = right.summary.expectancy95.lower;
    return rightRobust - leftRobust || right.summary.tradesPerMarketDay - left.summary.tradesPerMarketDay;
  })[0]!;
}

function rounded(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rounded(child)]));
  return value;
}

function writeFindings(report: any) {
  const dev = report.results.development;
  const check = report.results.historicalCheck;
  const markdown = `# EUR/USD New York Micro-Pullback Continuation V1\n\nVerdict: **${report.verdict}**\n\n## Frozen family\n\nThe selected development configuration requires a ${report.selection.minimumImpulseAtr.toFixed(1)} ATR impulse, a 15%-${(report.selection.maximumRetracement * 100).toFixed(0)}% pullback, a structural break in the completed H1 trend direction, and a ${report.selection.maximumHoldMinutes}-minute maximum hold. Entries occur at the following M5 open.\n\n## Results\n\n| Period | Trades | Trades/day | Profitable rate | Target rate | Expectancy | PF | Total R | Max DD | Positive months |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| Development | ${dev.trades} | ${dev.tradesPerMarketDay.toFixed(3)} | ${(dev.profitableRate * 100).toFixed(2)}% | ${(dev.targetRate * 100).toFixed(2)}% | ${dev.expectancyR.toFixed(3)}R | ${dev.profitFactor.toFixed(3)} | ${dev.totalR.toFixed(2)}R | ${dev.maxDrawdownR.toFixed(2)}R | ${dev.positiveMonths}/${dev.activeMonths} |\n| Later historical check | ${check.trades} | ${check.tradesPerMarketDay.toFixed(3)} | ${(check.profitableRate * 100).toFixed(2)}% | ${(check.targetRate * 100).toFixed(2)}% | ${check.expectancyR.toFixed(3)}R | ${check.profitFactor.toFixed(3)} | ${check.totalR.toFixed(2)}R | ${check.maxDrawdownR.toFixed(2)}R | ${check.positiveMonths}/${check.activeMonths} |\n\n## Evidence status\n\n${report.interpretation}\n`;
  writeFileSync(path.join(OUTPUT, "FINDINGS.md"), markdown);
}

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Loading EUR/USD M5 and H1 bid/ask candles...");
  const m5 = loadBars(M5_FILE);
  const h1 = loadBars(H1_FILE);
  const news = loadNewsTimes();
  const developmentDays = marketDays(m5, DEVELOPMENT);
  const checkDays = marketDays(m5, HISTORICAL_CHECK);
  const grid: Array<{ config: Config; trades: Trade[]; summary: ReturnType<typeof summarize> }> = [];
  for (const config of CONFIGS) {
    console.log(`Development family: ${config.name}`);
    const signals = buildSignals(m5, h1, news, config, DEVELOPMENT);
    const trades = replay(m5, signals, config);
    grid.push({ config, trades, summary: summarize(trades, developmentDays) });
  }
  const selected = select(grid);
  console.log(`Selected ${selected.config.name}; running frozen later historical check...`);
  const checkSignals = buildSignals(m5, h1, news, selected.config, HISTORICAL_CHECK);
  const checkTrades = replay(m5, checkSignals, selected.config);
  const checkSummary = summarize(checkTrades, checkDays);
  const positive = checkSummary.expectancyR > 0 && checkSummary.profitFactor > 1;
  const statisticallyPositive = checkSummary.expectancy95.lower > 0;
  const verdict = positive && statisticallyPositive
    ? "POSITIVE_HISTORICAL_CHECK_RESEARCH_ONLY"
    : positive
      ? "POSITIVE_POINT_ESTIMATE_EDGE_UNCERTAIN"
      : "NO_POSITIVE_HISTORICAL_EDGE";
  const interpretation = positive && statisticallyPositive
    ? "The frozen family produced positive expectancy whose interval remained above zero. The period was previously inspected by other research, so forward practice confirmation is still required."
    : positive
      ? `The frozen family finished positive, but its expectancy interval (${checkSummary.expectancy95.lower.toFixed(3)}R to ${checkSummary.expectancy95.upper.toFixed(3)}R) crosses zero. This is promising but unconfirmed.`
      : "The frozen family did not produce positive expectancy after realistic bid/ask costs. The entry hypothesis failed this historical check.";
  const report = rounded({
    generatedAt: new Date().toISOString(),
    verdict,
    isolation: { v19Modified: false, v4Modified: false, productionOrPaperBehaviorChanged: false },
    protocol: {
      instrument: "EUR_USD",
      data: "M5 and H1 historical bid/ask candles",
      session: "08:00-11:25 America/New_York, daylight-saving aware",
      entry: "completed impulse, completed pullback, completed structural-break candle, then next M5 open",
      trend: "latest completed H1 close and EMA20/EMA50 alignment plus EMA20 slope",
      execution: "historical bid/ask, 0.1 pip entry and exit slippage, structural stop, 2x stop-distance target yielding approximately +1.5R/-0.75R",
      ambiguity: "same M5 bar touching stop and target is charged as stop",
      filters: "maximum 0.30 spread/ATR, high-impact news blackout plus/minus 60 minutes, one open trade, maximum two daily",
    },
    periods: { development: DEVELOPMENT, historicalCheck: HISTORICAL_CHECK },
    selection: {
      ...selected.config,
      objective: "development only: at least 80 trades, positive expectancy, PF above 1, at least 55% positive active months; maximize lower expectancy bound",
      frontier: grid.map((row) => ({ ...row.config, ...row.summary })),
    },
    results: { development: selected.summary, historicalCheck: checkSummary },
    interpretation,
  }) as any;
  writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.development.json"), JSON.stringify(selected.trades, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.historical-check.json"), JSON.stringify(checkTrades, null, 2));
  writeFindings(report);
  console.log(JSON.stringify({ verdict, selection: report.selection && {
    name: report.selection.name,
    minimumImpulseAtr: report.selection.minimumImpulseAtr,
    maximumRetracement: report.selection.maximumRetracement,
    maximumHoldMinutes: report.selection.maximumHoldMinutes,
  }, development: report.results.development, historicalCheck: report.results.historicalCheck }, null, 2));
}

main();
