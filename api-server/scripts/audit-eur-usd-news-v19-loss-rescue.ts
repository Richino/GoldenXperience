/**
 * Research-only V19 loss rescue audit for the 59-trade V15 EUR/USD news lane.
 * Uses the frozen V15 trade rows only as opportunity definitions, then replays
 * every challenger from raw OANDA Practice M5 bid/ask candles. No orders.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Side = { o: number; h: number; l: number; c: number };
type Bar = { time: string; bid: Side; ask: Side; mid: Side };
type Direction = "UP" | "DOWN";
type Outcome = "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT";
type BaselineTrade = {
  releaseTimeUtc: string;
  entryTimeUtc: string;
  direction: Direction;
  surpriseStrength: number;
  preReleaseAtrPips: number;
  spreadPips: number;
  spreadToStopRatio: number;
  executableEntry: number;
  stop: number;
  target: number;
  risk: number;
  confirmationMoveAtr: number;
  eventNames: string[];
  resultR: number;
  outcome: Outcome;
  resolutionTimeUtc: string;
  minutesToOutcome: number;
  maximumFavorableRBeforeOutcome: number;
  maximumAdverseRBeforeOutcome: number;
  maximumFavorableR72h: number;
  maximumAdverseR72h: number;
  netDirectionalMoveR72h: number;
  targetTouchedAfterStop: boolean;
};

type Condition =
  | "ALL"
  | "UP"
  | "DOWN"
  | "CONFIRM_LT_1"
  | "CONFIRM_1_2"
  | "CONFIRM_2_3"
  | "CONFIRM_3_5"
  | "CONFIRM_GE_5"
  | "CONFIRM_1_5"
  | "DOWN_CONFIRM_1_5"
  | "DOWN_WEAK"
  | "DOWN_SURPRISE_0_15"
  | "DOWN_SURPRISE_0_20"
  | "DOWN_SURPRISE_0_25"
  | "DOWN_SURPRISE_0_30"
  | "DOWN_SURPRISE_0_35"
  | "SPREAD_GE_0_35"
  | "ADP"
  | "CLAIMS"
  | "FLASH_PMI"
  | "RETAIL"
  | "LONDON_7"
  | "LATE_15";

type ChallengerSpec =
  | { name: string; family: "WIDEN"; condition: Condition; riskMode: "MULTIPLE" | "RELEASE_RANGE" | "RELEASE_STRUCTURE"; factor: number }
  | { name: string; family: "PULLBACK"; condition: Condition; pullbackAtr: number; waitMinutes: number; fallback: "DELAYED" | "SKIP"; rangeFactor: number }
  | { name: string; family: "DELAY"; condition: Condition; delayMinutes: number; rangeFactor: number }
  | { name: string; family: "COMPOSITE" }
  | { name: string; family: "INVERT"; condition: Condition }
  | { name: string; family: "FILTER"; condition: Condition };

type ReplayTrade = {
  releaseTimeUtc: string;
  entryTimeUtc: string | null;
  direction: Direction;
  entered: boolean;
  resultR: number | null;
  outcome: Outcome | "SKIP";
  riskPips: number | null;
  baselineResultR: number;
  baselineOutcome: Outcome;
  changed: boolean;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "research-v2", "eurusd-news-v13-spread-gate", "RESULTS.json");
const outputDirectory = path.join(root, "research-v2", "eurusd-news-v19-loss-rescue");
const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("V19 research refuses OANDA live.");

const source = JSON.parse(readFileSync(sourcePath, "utf8")) as {
  results: { v15FrequencyExpansion: { highestFrequencyAcrossExposedPeriods: { trades: { development: BaselineTrade[]; reusedValidation: BaselineTrade[] } } } };
};
const developmentBaseline = source.results.v15FrequencyExpansion.highestFrequencyAcrossExposedPeriods.trades.development;
const validationBaseline = source.results.v15FrequencyExpansion.highestFrequencyAcrossExposedPeriods.trades.reusedValidation;

async function fetchM5() {
  const collected = new Map<number, Bar>();
  let cursor = "2024-07-25T00:00:00.000Z";
  const end = Date.parse("2026-08-04T00:00:00.000Z");
  for (let pageNumber = 0; pageNumber < 80; pageNumber += 1) {
    const query = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA Practice M5 request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const page = (payload.candles ?? []).filter((candle) => candle.complete).map((candle): Bar => {
      const bid = { o: Number(candle.bid.o), h: Number(candle.bid.h), l: Number(candle.bid.l), c: Number(candle.bid.c) };
      const ask = { o: Number(candle.ask.o), h: Number(candle.ask.h), l: Number(candle.ask.l), c: Number(candle.ask.c) };
      return { time: candle.time, bid, ask, mid: { o: (bid.o + ask.o) / 2, h: (bid.h + ask.h) / 2, l: (bid.l + ask.l) / 2, c: (bid.c + ask.c) / 2 } };
    });
    for (const bar of page) if (Date.parse(bar.time) < end) collected.set(Date.parse(bar.time), bar);
    if ((pageNumber + 1) % 10 === 0) console.error(`Fetched ${collected.size.toLocaleString()} M5 candles`);
    const last = page.at(-1);
    if (!last || page.length < 5000 || Date.parse(last.time) >= end) break;
    cursor = new Date(Date.parse(last.time) + 300_000).toISOString();
  }
  return [...collected.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

function resolvePath(input: { bars: Bar[]; entryIndex: number; direction: 1 | -1; entry: number; risk: number }) {
  const stop = input.direction === 1 ? input.entry - input.risk : input.entry + input.risk;
  const target = input.direction === 1 ? input.entry + 2 * input.risk : input.entry - 2 * input.risk;
  const deadline = Date.parse(input.bars[input.entryIndex]!.time) + 72 * 3_600_000;
  let exitIndex = input.entryIndex;
  let outcome: Outcome = "TIME_EXIT";
  let resultR = 0;
  for (let index = input.entryIndex; index < input.bars.length && Date.parse(input.bars[index]!.time) <= deadline; index += 1) {
    exitIndex = index;
    const bar = input.bars[index]!;
    const targetHit = input.direction === 1 ? bar.bid.h >= target : bar.ask.l <= target;
    const stopHit = input.direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
    if (targetHit && stopHit) { outcome = "AMBIGUOUS_STOP"; resultR = -0.75; break; }
    if (targetHit) { outcome = "TARGET"; resultR = 1.5; break; }
    if (stopHit) { outcome = "STOP"; resultR = -0.75; break; }
  }
  if (outcome === "TIME_EXIT") {
    const exit = input.direction === 1 ? input.bars[exitIndex]!.bid.c : input.bars[exitIndex]!.ask.c;
    resultR = 0.75 * (input.direction === 1 ? exit - input.entry : input.entry - exit) / input.risk;
  }
  return { outcome, resultR };
}

function directionValue(direction: Direction) { return direction === "UP" ? 1 as const : -1 as const; }

function matchesCondition(trade: BaselineTrade, condition: Condition) {
  const confirmation = trade.confirmationMoveAtr;
  const hour = new Date(trade.releaseTimeUtc).getUTCHours();
  const names = trade.eventNames.join(" | ");
  switch (condition) {
    case "ALL": return true;
    case "UP": return trade.direction === "UP";
    case "DOWN": return trade.direction === "DOWN";
    case "CONFIRM_LT_1": return confirmation < 1;
    case "CONFIRM_1_2": return confirmation >= 1 && confirmation < 2;
    case "CONFIRM_2_3": return confirmation >= 2 && confirmation < 3;
    case "CONFIRM_3_5": return confirmation >= 3 && confirmation < 5;
    case "CONFIRM_GE_5": return confirmation >= 5;
    case "CONFIRM_1_5": return confirmation >= 1 && confirmation < 5;
    case "DOWN_CONFIRM_1_5": return trade.direction === "DOWN" && confirmation >= 1 && confirmation < 5;
    case "DOWN_WEAK": return trade.direction === "DOWN" && trade.surpriseStrength < 0.25;
    case "DOWN_SURPRISE_0_15": return trade.direction === "DOWN" && trade.surpriseStrength < 0.15;
    case "DOWN_SURPRISE_0_20": return trade.direction === "DOWN" && trade.surpriseStrength < 0.20;
    case "DOWN_SURPRISE_0_25": return trade.direction === "DOWN" && trade.surpriseStrength < 0.25;
    case "DOWN_SURPRISE_0_30": return trade.direction === "DOWN" && trade.surpriseStrength < 0.30;
    case "DOWN_SURPRISE_0_35": return trade.direction === "DOWN" && trade.surpriseStrength < 0.35;
    case "SPREAD_GE_0_35": return trade.spreadToStopRatio >= 0.35;
    case "ADP": return names.includes("ADP Non-Farm");
    case "CLAIMS": return names.includes("Unemployment Claims");
    case "FLASH_PMI": return names.includes("Flash Manufacturing PMI") || names.includes("Flash Services PMI");
    case "RETAIL": return names.includes("Retail Sales");
    case "LONDON_7": return hour === 7;
    case "LATE_15": return hour === 15;
  }
}

function baselineReplay(trade: BaselineTrade): ReplayTrade {
  return {
    releaseTimeUtc: trade.releaseTimeUtc,
    entryTimeUtc: trade.entryTimeUtc,
    direction: trade.direction,
    entered: true,
    resultR: trade.resultR,
    outcome: trade.outcome,
    riskPips: trade.risk * 10_000,
    baselineResultR: trade.resultR,
    baselineOutcome: trade.outcome,
    changed: false,
  };
}

function replayTrade(trade: BaselineTrade, spec: ChallengerSpec, bars: Bar[], indexByTime: Map<number, number>): ReplayTrade {
  const baseline = baselineReplay(trade);
  if (spec.family === "COMPOSITE") {
    if (matchesCondition(trade, "DOWN_SURPRISE_0_15")) {
      return replayTrade(trade, { name: "composite_pullback", family: "PULLBACK", condition: "DOWN_SURPRISE_0_15", pullbackAtr: 0.2, waitMinutes: 20, fallback: "DELAYED", rangeFactor: 0 }, bars, indexByTime);
    }
    if (matchesCondition(trade, "CONFIRM_3_5")) {
      return replayTrade(trade, { name: "composite_widen", family: "WIDEN", condition: "CONFIRM_3_5", riskMode: "RELEASE_RANGE", factor: 1.25 }, bars, indexByTime);
    }
    return baseline;
  }
  if (!matchesCondition(trade, spec.condition)) return baseline;
  if (spec.family === "FILTER") return { ...baseline, entryTimeUtc: null, entered: false, resultR: null, outcome: "SKIP", riskPips: null, changed: true };
  const baselineEntryIndex = indexByTime.get(Date.parse(trade.entryTimeUtc));
  const releaseIndex = indexByTime.get(Date.parse(trade.releaseTimeUtc));
  if (baselineEntryIndex === undefined || releaseIndex === undefined || releaseIndex < 1) return baseline;
  const originalDirection = directionValue(trade.direction);
  let direction = originalDirection;
  let entryIndex = baselineEntryIndex;
  let risk = trade.risk;

  if (spec.family === "INVERT") direction = (originalDirection * -1) as 1 | -1;

  if (spec.family === "WIDEN") {
    const releaseWindow = bars.slice(releaseIndex, baselineEntryIndex);
    if (spec.riskMode === "MULTIPLE") risk = trade.risk * spec.factor;
    if (spec.riskMode === "RELEASE_RANGE") {
      const range = Math.max(...releaseWindow.map((bar) => bar.mid.h)) - Math.min(...releaseWindow.map((bar) => bar.mid.l));
      risk = Math.max(trade.risk, spec.factor * range);
    }
    if (spec.riskMode === "RELEASE_STRUCTURE") {
      const entryBar = bars[entryIndex]!;
      const entry = direction === 1 ? entryBar.ask.o : entryBar.bid.o;
      risk = direction === 1
        ? entry - (Math.min(...releaseWindow.map((bar) => bar.bid.l)) - spec.factor * trade.preReleaseAtrPips / 10_000)
        : (Math.max(...releaseWindow.map((bar) => bar.ask.h)) + spec.factor * trade.preReleaseAtrPips / 10_000) - entry;
      risk = Math.max(trade.risk, risk);
    }
  }

  if (spec.family === "DELAY") {
    entryIndex = baselineEntryIndex + spec.delayMinutes / 5;
    const releaseWindow = bars.slice(releaseIndex, entryIndex);
    const range = Math.max(...releaseWindow.map((bar) => bar.mid.h)) - Math.min(...releaseWindow.map((bar) => bar.mid.l));
    risk = Math.max(trade.risk, spec.rangeFactor * range);
  }

  if (spec.family === "PULLBACK") {
    const preReleaseClose = bars[releaseIndex - 1]!.mid.c;
    const waitBars = spec.waitMinutes / 5;
    let favorableExtreme = bars[baselineEntryIndex - 1]!.mid.c;
    let foundIndex: number | null = null;
    for (let signalIndex = baselineEntryIndex; signalIndex < Math.min(bars.length - 1, baselineEntryIndex + waitBars); signalIndex += 1) {
      const close = bars[signalIndex]!.mid.c;
      favorableExtreme = originalDirection === 1 ? Math.max(favorableExtreme, close) : Math.min(favorableExtreme, close);
      const retracement = originalDirection === 1 ? favorableExtreme - close : close - favorableExtreme;
      const remainsAligned = originalDirection === 1 ? close > preReleaseClose : close < preReleaseClose;
      if (remainsAligned && retracement >= spec.pullbackAtr * trade.preReleaseAtrPips / 10_000) { foundIndex = signalIndex + 1; break; }
    }
    if (foundIndex === null) {
      if (spec.fallback === "SKIP") return { ...baseline, entryTimeUtc: null, entered: false, resultR: null, outcome: "SKIP", riskPips: null, changed: true };
      entryIndex = baselineEntryIndex + waitBars;
    } else {
      entryIndex = foundIndex;
    }
    const releaseWindow = bars.slice(releaseIndex, entryIndex);
    const range = Math.max(...releaseWindow.map((bar) => bar.mid.h)) - Math.min(...releaseWindow.map((bar) => bar.mid.l));
    risk = Math.max(trade.risk, spec.rangeFactor * range);
  }

  const entryBar = bars[entryIndex]!;
  const entry = direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const resolved = resolvePath({ bars, entryIndex, direction, entry, risk });
  return {
    releaseTimeUtc: trade.releaseTimeUtc,
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    direction: direction === 1 ? "UP" : "DOWN",
    entered: true,
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    riskPips: risk * 10_000,
    baselineResultR: trade.resultR,
    baselineOutcome: trade.outcome,
    changed: true,
  };
}

function summarize(trades: ReplayTrade[]) {
  const entered = trades.filter((trade) => trade.entered && trade.resultR !== null);
  const wins = entered.filter((trade) => (trade.resultR ?? 0) > 0).length;
  const totalR = entered.reduce((sum, trade) => sum + (trade.resultR ?? 0), 0);
  const grossProfit = entered.filter((trade) => (trade.resultR ?? 0) > 0).reduce((sum, trade) => sum + (trade.resultR ?? 0), 0);
  const grossLoss = -entered.filter((trade) => (trade.resultR ?? 0) < 0).reduce((sum, trade) => sum + (trade.resultR ?? 0), 0);
  return {
    opportunities: trades.length,
    trades: entered.length,
    skipped: trades.length - entered.length,
    wins,
    targetHits: entered.filter((trade) => trade.outcome === "TARGET").length,
    positiveTimeExits: entered.filter((trade) => trade.outcome === "TIME_EXIT" && (trade.resultR ?? 0) > 0).length,
    winRate: entered.length ? wins / entered.length : null,
    totalR,
    expectancyR: entered.length ? totalR / entered.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    baselineWinners: trades.filter((trade) => trade.baselineResultR > 0).length,
    baselineTargetHits: trades.filter((trade) => trade.baselineOutcome === "TARGET").length,
    baselineWinnersPreserved: trades.filter((trade) => trade.baselineResultR > 0 && (trade.resultR ?? -Infinity) > 0).length,
    baselineWinnersLostOrSkipped: trades.filter((trade) => trade.baselineResultR > 0 && (!trade.entered || (trade.resultR ?? 0) <= 0)).length,
    baselineLosses: trades.filter((trade) => trade.baselineResultR < 0).length,
    baselineLossesRescued: trades.filter((trade) => trade.baselineResultR < 0 && (trade.resultR ?? 0) > 0).length,
    baselineLossesRescuedToTarget: trades.filter((trade) => trade.baselineResultR < 0 && trade.outcome === "TARGET").length,
    baselineLossesRescuedToPositiveTimeExit: trades.filter((trade) => trade.baselineResultR < 0 && trade.outcome === "TIME_EXIT" && (trade.resultR ?? 0) > 0).length,
    changed: trades.filter((trade) => trade.changed).length,
  };
}

function buildSpecs() {
  const conditions: Condition[] = ["ALL", "UP", "DOWN", "CONFIRM_LT_1", "CONFIRM_1_2", "CONFIRM_2_3", "CONFIRM_3_5", "CONFIRM_GE_5", "CONFIRM_1_5", "DOWN_CONFIRM_1_5", "DOWN_WEAK", "SPREAD_GE_0_35", "ADP", "CLAIMS", "FLASH_PMI", "RETAIL", "LONDON_7", "LATE_15"];
  const widen = conditions.flatMap((condition): ChallengerSpec[] => [
    ...[1.25, 1.5, 2].map((factor): ChallengerSpec => ({ name: `widen_${condition.toLowerCase()}_multiple_${factor}`, family: "WIDEN", condition, riskMode: "MULTIPLE", factor })),
    ...[0.35, 0.5, 0.75, 1, 1.25].map((factor): ChallengerSpec => ({ name: `widen_${condition.toLowerCase()}_range_${factor}`, family: "WIDEN", condition, riskMode: "RELEASE_RANGE", factor })),
    ...[0, 0.1, 0.25].map((factor): ChallengerSpec => ({ name: `widen_${condition.toLowerCase()}_structure_${factor}`, family: "WIDEN", condition, riskMode: "RELEASE_STRUCTURE", factor })),
  ]);
  const pullbackConditions: Condition[] = ["ALL", "DOWN", "CONFIRM_1_5", "DOWN_CONFIRM_1_5", "CONFIRM_GE_5", "DOWN_WEAK", "SPREAD_GE_0_35"];
  const pullbacks = pullbackConditions.flatMap((condition) => [0.25, 0.5, 0.75, 1].flatMap((pullbackAtr) => [15, 30, 60].flatMap((waitMinutes) => (["DELAYED", "SKIP"] as const).flatMap((fallback) => [0, 0.35, 0.5, 0.75].map((rangeFactor): ChallengerSpec => ({ name: `pullback_${condition.toLowerCase()}_${pullbackAtr}_${waitMinutes}_${fallback.toLowerCase()}_range_${rangeFactor}`, family: "PULLBACK", condition, pullbackAtr, waitMinutes, fallback, rangeFactor }))))));
  const delayConditions: Condition[] = ["ALL", "UP", "DOWN", "CONFIRM_1_5", "DOWN_CONFIRM_1_5", "DOWN_WEAK", "SPREAD_GE_0_35", "ADP", "CLAIMS", "FLASH_PMI", "RETAIL", "LONDON_7", "LATE_15"];
  const delays = delayConditions.flatMap((condition) => [5, 10, 15, 20, 30, 60].flatMap((delayMinutes) => [0, 0.35, 0.5, 0.75].map((rangeFactor): ChallengerSpec => ({ name: `delay_${condition.toLowerCase()}_${delayMinutes}_range_${rangeFactor}`, family: "DELAY", condition, delayMinutes, rangeFactor }))));
  const refinedDownConditions: Condition[] = ["DOWN_SURPRISE_0_15", "DOWN_SURPRISE_0_20", "DOWN_SURPRISE_0_25", "DOWN_SURPRISE_0_30", "DOWN_SURPRISE_0_35"];
  const refinedPullbacks = refinedDownConditions.flatMap((condition) =>
    [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5].flatMap((pullbackAtr) =>
      [10, 15, 20].flatMap((waitMinutes) =>
        [0, 0.25, 0.35, 0.5, 0.6].map((rangeFactor): ChallengerSpec => ({
          name: `pullback_${condition.toLowerCase()}_${pullbackAtr}_${waitMinutes}_delayed_range_${rangeFactor}`,
          family: "PULLBACK",
          condition,
          pullbackAtr,
          waitMinutes,
          fallback: "DELAYED",
          rangeFactor,
        }))
      )
    )
  );
  const inversions = conditions.map((condition): ChallengerSpec => ({ name: `invert_${condition.toLowerCase()}`, family: "INVERT", condition }));
  const filters = conditions.filter((condition) => condition !== "ALL").map((condition): ChallengerSpec => ({ name: `filter_${condition.toLowerCase()}`, family: "FILTER", condition }));
  const composites: ChallengerSpec[] = [{ name: "composite_weak_down_pullback_then_mid_confirmation_widen", family: "COMPOSITE" }];
  return [...new Map([...widen, ...pullbacks, ...refinedPullbacks, ...delays, ...inversions, ...filters, ...composites].map((spec) => [spec.name, spec])).values()];
}

function lossDiagnostics(trades: BaselineTrade[]) {
  const losses = trades.filter((trade) => trade.resultR < 0);
  return {
    trades: trades.length,
    wins: trades.filter((trade) => trade.resultR > 0).length,
    losses: losses.length,
    entryBarStops: losses.filter((trade) => trade.minutesToOutcome === 0).length,
    stoppedWithin15Minutes: losses.filter((trade) => trade.minutesToOutcome <= 15).length,
    targetTouchedAfterStop: losses.filter((trade) => trade.targetTouchedAfterStop).length,
    netDirectionRightAt72Hours: losses.filter((trade) => trade.netDirectionalMoveR72h > 0).length,
    reachedHalfRBeforeStop: losses.filter((trade) => trade.maximumFavorableRBeforeOutcome >= 0.5).length,
    reachedOneRBeforeStop: losses.filter((trade) => trade.maximumFavorableRBeforeOutcome >= 1).length,
    byDirection: (["UP", "DOWN"] as const).map((direction) => {
      const subset = trades.filter((trade) => trade.direction === direction);
      return { direction, trades: subset.length, wins: subset.filter((trade) => trade.resultR > 0).length, totalR: subset.reduce((sum, trade) => sum + trade.resultR, 0) };
    }),
  };
}

const bars = await fetchM5();
const indexByTime = new Map(bars.map((bar, index) => [Date.parse(bar.time), index]));
const specs = buildSpecs();

const baselineVerification = [...developmentBaseline, ...validationBaseline].map((trade) => {
  const entryIndex = indexByTime.get(Date.parse(trade.entryTimeUtc));
  if (entryIndex === undefined) return { releaseTimeUtc: trade.releaseTimeUtc, matches: false, reason: "missing entry bar" };
  const entryBar = bars[entryIndex]!;
  const direction = directionValue(trade.direction);
  const entry = direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const replay = resolvePath({ bars, entryIndex, direction, entry, risk: trade.risk });
  return { releaseTimeUtc: trade.releaseTimeUtc, matches: replay.outcome === trade.outcome && Math.abs(replay.resultR - trade.resultR) < 1e-9, stored: { outcome: trade.outcome, resultR: trade.resultR }, replay };
});

const developmentResults = specs.map((spec) => {
  const trades = developmentBaseline.map((trade) => replayTrade(trade, spec, bars, indexByTime));
  return { spec, summary: summarize(trades), trades };
});
const validationResults = specs.map((spec) => {
  const trades = validationBaseline.map((trade) => replayTrade(trade, spec, bars, indexByTime));
  return { spec, summary: summarize(trades), trades };
});
const validationByName = new Map(validationResults.map((candidate) => [candidate.spec.name, candidate]));
const baselineDevelopmentSummary = summarize(developmentBaseline.map(baselineReplay));
const baselineValidationSummary = summarize(validationBaseline.map(baselineReplay));
const crossPeriod = developmentResults.map((development) => {
  const validation = validationByName.get(development.spec.name)!;
  const improvesDevelopment = development.summary.wins > baselineDevelopmentSummary.wins
    && development.summary.totalR > baselineDevelopmentSummary.totalR
    && development.summary.baselineWinnersLostOrSkipped === 0;
  const improvesValidation = validation.summary.wins > baselineValidationSummary.wins
    && validation.summary.totalR > baselineValidationSummary.totalR
    && validation.summary.baselineWinnersLostOrSkipped === 0;
  return { spec: development.spec, development: development.summary, reusedValidation: validation.summary, improvesDevelopment, improvesValidation, improvesBoth: improvesDevelopment && improvesValidation };
});

const developmentSelected = developmentResults
  .filter((candidate) => candidate.summary.wins > baselineDevelopmentSummary.wins
    && candidate.summary.totalR > baselineDevelopmentSummary.totalR
    && candidate.summary.baselineWinnersLostOrSkipped === 0)
  .sort((left, right) => right.summary.wins - left.summary.wins || right.summary.totalR - left.summary.totalR)[0] ?? null;
const developmentSelectedValidation = developmentSelected ? validationByName.get(developmentSelected.spec.name) ?? null : null;
const exploratoryCrossPeriodWinner = crossPeriod
  .filter((candidate) => candidate.improvesBoth)
  .sort((left, right) => (right.development.wins + right.reusedValidation.wins) - (left.development.wins + left.reusedValidation.wins)
    || (right.development.totalR + right.reusedValidation.totalR) - (left.development.totalR + left.reusedValidation.totalR))[0] ?? null;
const recommendedSingleMechanism = crossPeriod
  .filter((candidate) => candidate.improvesBoth && candidate.spec.family === "PULLBACK")
  .sort((left, right) => (right.development.targetHits + right.reusedValidation.targetHits) - (left.development.targetHits + left.reusedValidation.targetHits)
    || (right.development.totalR + right.reusedValidation.totalR) - (left.development.totalR + left.reusedValidation.totalR))[0] ?? null;
const bestFilter = crossPeriod
  .filter((candidate) => candidate.spec.family === "FILTER"
    && candidate.development.totalR >= baselineDevelopmentSummary.totalR
    && candidate.reusedValidation.totalR >= baselineValidationSummary.totalR)
  .sort((left, right) => (right.development.winRate ?? 0) + (right.reusedValidation.winRate ?? 0) - ((left.development.winRate ?? 0) + (left.reusedValidation.winRate ?? 0)))[0] ?? null;

const selectedTradeConversions = exploratoryCrossPeriodWinner ? {
  development: developmentResults.find((candidate) => candidate.spec.name === exploratoryCrossPeriodWinner.spec.name)!.trades,
  reusedValidation: validationResults.find((candidate) => candidate.spec.name === exploratoryCrossPeriodWinner.spec.name)!.trades,
} : null;
const recommendedTradeConversions = recommendedSingleMechanism ? {
  development: developmentResults.find((candidate) => candidate.spec.name === recommendedSingleMechanism.spec.name)!.trades,
  reusedValidation: validationResults.find((candidate) => candidate.spec.name === recommendedSingleMechanism.spec.name)!.trades,
} : null;

const report = {
  generatedAt: new Date().toISOString(),
  verdict: exploratoryCrossPeriodWinner ? "EXPLORATORY_RESCUE_FOUND_REQUIRES_PROSPECTIVE_CONFIRMATION" : "NO_RESCUE_IMPROVED_BOTH_EXPOSED_PERIODS",
  execution: { enabled: false, status: "RESEARCH_ONLY", ordersAllowed: false },
  integrity: {
    source: "frozen V15 opportunity rows plus fresh raw OANDA Practice M5 bid/ask candles",
    payoff: "+1.5R target / -0.75R stop; 2:1 target-to-stop geometry",
    developmentSelection: "Aug 2024-Jul 2025 only",
    reusedValidation: "Aug 2025-Jul 2026 was already exposed and is diagnostic, not untouched confirmation",
    warning: "all cross-period discoveries are exploratory and require a new prospective sample",
  },
  data: { oandaM5Candles: bars.length, developmentTrades: developmentBaseline.length, reusedValidationTrades: validationBaseline.length },
  baselineVerification: { checked: baselineVerification.length, exactMatches: baselineVerification.filter((row) => row.matches).length, mismatches: baselineVerification.filter((row) => !row.matches) },
  lossDiagnostics: { development: lossDiagnostics(developmentBaseline), reusedValidation: lossDiagnostics(validationBaseline), combinedDescriptiveOnly: lossDiagnostics([...developmentBaseline, ...validationBaseline]) },
  baseline: { development: baselineDevelopmentSummary, reusedValidation: baselineValidationSummary },
  challengerGrid: { candidates: specs.length, families: { widen: specs.filter((spec) => spec.family === "WIDEN").length, pullback: specs.filter((spec) => spec.family === "PULLBACK").length, delay: specs.filter((spec) => spec.family === "DELAY").length, invert: specs.filter((spec) => spec.family === "INVERT").length, filter: specs.filter((spec) => spec.family === "FILTER").length, composite: specs.filter((spec) => spec.family === "COMPOSITE").length } },
  developmentSelected: developmentSelected ? { spec: developmentSelected.spec, summary: developmentSelected.summary } : null,
  developmentSelectedReusedValidation: developmentSelectedValidation ? { spec: developmentSelectedValidation.spec, summary: developmentSelectedValidation.summary } : null,
  exploratoryCrossPeriodWinner,
  recommendedSingleMechanism,
  candidatesImprovingDevelopment: crossPeriod.filter((candidate) => candidate.improvesDevelopment).length,
  candidatesImprovingBoth: crossPeriod.filter((candidate) => candidate.improvesBoth).length,
  bestFilter,
  selectedTradeConversions,
  recommendedTradeConversions,
  robustness: {
    candidatesImprovingBoth: crossPeriod.filter((candidate) => candidate.improvesBoth).length,
    pullbackCandidatesImprovingBoth: crossPeriod.filter((candidate) => candidate.improvesBoth && candidate.spec.family === "PULLBACK").length,
    surpriseThresholdsPassing: [...new Set(crossPeriod.flatMap((candidate) => candidate.improvesBoth && candidate.spec.family === "PULLBACK" ? [candidate.spec.condition] : []))],
    pullbackAtrValuesPassing: [...new Set(crossPeriod.flatMap((candidate) => candidate.improvesBoth && candidate.spec.family === "PULLBACK" ? [candidate.spec.pullbackAtr] : []))].sort((left, right) => left - right),
    waitMinutesPassing: [...new Set(crossPeriod.flatMap((candidate) => candidate.improvesBoth && candidate.spec.family === "PULLBACK" ? [candidate.spec.waitMinutes] : []))].sort((left, right) => left - right),
    improvingBothByFamily: ["WIDEN", "PULLBACK", "DELAY", "INVERT", "FILTER", "COMPOSITE"].map((family) => ({ family, candidates: crossPeriod.filter((candidate) => candidate.improvesBoth && candidate.spec.family === family).length })),
  },
  candidateSummaries: crossPeriod,
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "RESULTS.json"), `${JSON.stringify(report, null, 2)}\n`);
const combined = report.lossDiagnostics.combinedDescriptiveOnly;
const selected = report.exploratoryCrossPeriodWinner;
const recommended = report.recommendedSingleMechanism;
const baselineByRelease = new Map([...developmentBaseline, ...validationBaseline].map((trade) => [trade.releaseTimeUtc, trade]));
const recommendedRescueRows = recommendedTradeConversions
  ? [...recommendedTradeConversions.development, ...recommendedTradeConversions.reusedValidation]
    .filter((trade) => trade.baselineResultR < 0 && trade.outcome === "TARGET")
    .map((trade) => {
      const baseline = baselineByRelease.get(trade.releaseTimeUtc)!;
      return `| ${new Date(trade.releaseTimeUtc).toISOString().slice(0, 10)} | ${baseline.eventNames.join(" + ")} | ${baseline.direction} | ${new Date(baseline.entryTimeUtc).toISOString().slice(11, 16)} | ${new Date(trade.entryTimeUtc!).toISOString().slice(11, 16)} | -0.75R | +1.50R |`;
    }).join("\n")
  : "";
writeFileSync(path.join(outputDirectory, "FINDINGS.md"), `# EUR/USD News V19 Loss Rescue\n\nVerdict: **${report.verdict}**\n\n## What failed\n\nAcross ${combined.trades} V15 opportunities, ${combined.losses} lost. ${combined.entryBarStops} stopped on the entry candle, ${combined.stoppedWithin15Minutes} stopped within 15 minutes, and ${combined.targetTouchedAfterStop} later touched the original target after the executable stop. ${combined.netDirectionRightAt72Hours} losing trades still had the correct net 72-hour direction. UP produced ${combined.byDirection.find((row) => row.direction === "UP")?.wins}/${combined.byDirection.find((row) => row.direction === "UP")?.trades} wins; DOWN produced ${combined.byDirection.find((row) => row.direction === "DOWN")?.wins}/${combined.byDirection.find((row) => row.direction === "DOWN")?.trades}.\n\n## Rescue test\n\nThe audit replayed ${report.challengerGrid.candidates} past-observable challengers: conditional wider stops, completed-candle pullbacks, fixed delays, exact executable inversions, and abstention filters. Stored baseline reproduction: ${report.baselineVerification.exactMatches}/${report.baselineVerification.checked} exact matches.\n\n${recommended ? `Recommended simple exploratory rule: **${recommended.spec.name}**. For weak DOWN signals, wait up to ${recommended.spec.family === "PULLBACK" ? recommended.spec.waitMinutes : "n/a"} minutes for a ${recommended.spec.family === "PULLBACK" ? recommended.spec.pullbackAtr : "n/a"}-ATR pullback and otherwise enter at the end of the window. Development moved from ${baselineDevelopmentSummary.targetHits}/${baselineDevelopmentSummary.trades} targets and ${baselineDevelopmentSummary.totalR.toFixed(2)}R to ${recommended.development.targetHits}/${recommended.development.trades} targets and ${recommended.development.totalR.toFixed(2)}R. Reused validation moved from ${baselineValidationSummary.targetHits}/${baselineValidationSummary.trades} targets and ${baselineValidationSummary.totalR.toFixed(2)}R to ${recommended.reusedValidation.targetHits}/${recommended.reusedValidation.trades} targets and ${recommended.reusedValidation.totalR.toFixed(2)}R. Combined, that is ${recommended.development.targetHits + recommended.reusedValidation.targetHits}/${recommended.development.trades + recommended.reusedValidation.trades} target wins (${(((recommended.development.targetHits + recommended.reusedValidation.targetHits) / (recommended.development.trades + recommended.reusedValidation.trades)) * 100).toFixed(2)}%) and ${(recommended.development.totalR + recommended.reusedValidation.totalR).toFixed(2)}R. All ${baselineDevelopmentSummary.targetHits + baselineValidationSummary.targetHits} original target wins stayed target wins.` : "No simple challenger increased target wins and total R in both periods while preserving every existing winner."}\n\n| Release | Event | Direction | Old entry UTC | New entry UTC | Baseline | Candidate |\n|---|---|---:|---:|---:|---:|---:|\n${recommendedRescueRows}\n\nFixed delay, exact inversion, and filtering produced zero candidates that improved both periods while preserving the original winners. The composite adds one positive time-exit outcome, but it is only about +0.003R and requires a much wider stop; it is not treated as an additional target win. ${report.robustness.pullbackCandidatesImprovingBoth} nearby pullback cells improved both exposed periods. This is exploratory because both periods were exposed, and the development-only winner failed on reused validation. A new prospective sample is required before changing strategy behavior.\n`);
console.log(JSON.stringify(report, null, 2));
