import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import { completedCandles, evaluateHardGates } from "@/lib/strategy/strategy-common";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, PairStrategyId, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * Shared mechanics for the explicitly frozen H1 pair contracts.  This is not
 * a strategy selector: each pair module supplies its immutable rule contract
 * and exports its own evaluator.  The evaluator is deliberately pure; open
 * position, duplicate, and enabled state are held by the runtime state store.
 */
export interface FrozenH1PairContract<Id extends PairStrategyId> {
  id: Id; name: string; version: string; configVersion: string; symbol: string;
  originHour: number; direction: "long" | "short"; consensus?: "bull" | "bear";
  structure?: "hhhl" | "lhll"; previousHighBreak?: boolean; rangeHours?: readonly number[];
  bodyExtreme?: boolean; breakClearanceAtr?: number; emaReclaim?: boolean;
}

export interface FrozenH1EvaluationOptions { timeframe?: string; hasActivePosition?: boolean; duplicateSignal?: boolean; }

export interface FrozenH1ExitQuote {
  closeTime: string;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askHigh: number;
  askLow: number;
  askClose: number;
}

export interface FrozenH1ExitInput {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
  quotes: readonly FrozenH1ExitQuote[];
  now: Date;
}

export interface FrozenH1ExitResult {
  outcome: "target_first" | "stop_first" | "time_exit";
  exitReason: "TP" | "SL" | "TIME_EXIT";
  exit: number;
  resultR: number;
  resolvedAt: string;
  horizonEndsAt: string;
  barsHeld: number;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
}

/** Exact three-contiguous-H1 resolver shared by the frozen H1 pair modules. */
export function resolveFrozenH1Exit(input: FrozenH1ExitInput): FrozenH1ExitResult | null {
  const decisionMs = Date.parse(input.decisionTime);
  const maxHoldBars = 3;
  const horizonMs = decisionMs + maxHoldBars * 60 * 60_000;
  const horizonEndsAt = new Date(horizonMs).toISOString();
  const risk = Math.abs(input.entry - input.stop);
  const validGeometry = input.direction === "long"
    ? input.stop < input.entry && input.entry < input.target
    : input.target < input.entry && input.entry < input.stop;
  if (!Number.isFinite(decisionMs) || !(risk > 0) || !validGeometry) return null;

  const quoteByClose = new Map(input.quotes.map((quote) => [Date.parse(quote.closeTime), quote]));
  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;
  for (let bar = 1; bar <= maxHoldBars; bar += 1) {
    const quote = quoteByClose.get(decisionMs + bar * 60 * 60_000);
    if (!quote) return null;
    const favorable = input.direction === "long"
      ? (quote.bidHigh - input.entry) / risk
      : (input.entry - quote.askLow) / risk;
    const adverse = input.direction === "long"
      ? (input.entry - quote.bidLow) / risk
      : (quote.askHigh - input.entry) / risk;
    maxFavorableR = Math.max(maxFavorableR ?? favorable, favorable);
    maxAdverseR = Math.max(maxAdverseR ?? adverse, adverse);
    const targetHit = input.direction === "long" ? quote.bidHigh >= input.target : quote.askLow <= input.target;
    const stopHit = input.direction === "long" ? quote.bidLow <= input.stop : quote.askHigh >= input.stop;
    if (stopHit) return { outcome: "stop_first", exitReason: "SL", exit: input.stop, resultR: -1, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: bar, maxFavorableR, maxAdverseR };
    if (targetHit) return { outcome: "target_first", exitReason: "TP", exit: input.target, resultR: 2, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: bar, maxFavorableR, maxAdverseR };
    if (bar === maxHoldBars) {
      if (input.now.getTime() < horizonMs) return null;
      const exit = input.direction === "long" ? quote.bidClose : quote.askClose;
      const resultR = input.direction === "long" ? (exit - input.entry) / risk : (input.entry - exit) / risk;
      return { outcome: "time_exit", exitReason: "TIME_EXIT", exit, resultR, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: bar, maxFavorableR, maxAdverseR };
    }
  }
  return null;
}

const vote = (left: number, right: number) => left > right ? 1 : left < right ? -1 : 0;
const exactH1 = (value: Date) => value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0;
const condition = (name: string, passed: boolean, reason: string, currentValue: string, required = true): StrategyCondition => ({ name, passed, reason, currentValue, required });

function clean(candles: readonly Candle[]) {
  const sorted = candles.filter((candle) => candle.complete).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return sorted.filter((candle, index) => index === 0 || candle.time !== sorted[index - 1]!.time);
}

function regime(contract: FrozenH1PairContract<PairStrategyId>, evaluatedAt: string, atr: number | null, ema20: number | null, ema50: number | null): MarketRegime {
  const pip = pipSizeFor(contract.symbol);
  return { regime: "mixed", trendDirection: ema20 === null || ema50 === null ? "none" : ema20 > ema50 ? "up" : ema20 < ema50 ? "down" : "none", trendStrength: 0, volatility: "normal", atr, atrPips: atr === null ? null : atr / pip, momentumState: "steady", emaFast: ema20, emaMid: ema50, emaSlow: null, slopeAtrPerBar: null, rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null, lookbackBars: 50, evaluatedAt };
}

export function evaluateFrozenH1Pair<Id extends PairStrategyId>(contract: FrozenH1PairContract<Id>, input: StrategyEvaluationInput, options: FrozenH1EvaluationOptions = {}): StrategyCandidate<Id> {
  const candles = clean(input.candles1h);
  const current = candles.at(-1); const previous = candles.at(-2); const threeBack = candles.at(-4);
  const ema20s = calculateEmaValues(candles.map((c) => c.close), 20);
  const ema50s = calculateEmaValues(candles.map((c) => c.close), 50);
  const atrs = calculateAtrValues(candles, 14);
  const index = candles.length - 1; const ema20 = ema20s[index] ?? null; const ema50 = ema50s[index] ?? null;
  const ema20Back = ema20s[index - 3] ?? null; const atr14 = atrs[index] ?? null;
  const origin = Boolean(current && exactH1(new Date(current.time)) && new Date(current.time).getUTCHours() === contract.originHour);
  const ready = Boolean(current && previous && threeBack && ema20 !== null && ema50 !== null && ema20Back !== null && atr14 !== null && atr14 > 0);
  const consensus = !ready ? 0 : vote(ema20!, ema50!) + vote(current!.close, ema20!) + vote(ema20!, ema20Back!) + vote(current!.close, threeBack!.close);
  const consensusOk = contract.consensus === undefined || (ready && (contract.consensus === "bull" ? consensus >= 3 : consensus <= -3));
  const structureOk = contract.structure === undefined || (ready && (contract.structure === "hhhl" ? current!.high > previous!.high && current!.low > previous!.low : current!.high < previous!.high && current!.low < previous!.low));
  const prevHighOk = !contract.previousHighBreak || (ready && current!.close > previous!.high);
  const clearanceOk = contract.breakClearanceAtr === undefined || (ready && current!.close - previous!.high >= contract.breakClearanceAtr * atr14!);
  const reclaimOk = !contract.emaReclaim || (ready && previous!.close <= ema20s[index - 1]! && current!.close > ema20!);
  const range = current ? current.high - current.low : 0;
  const bodyExtremeOk = !contract.bodyExtreme || (ready && current!.close > current!.open && Math.abs(current!.close - current!.open) >= .5 * atr14! && range > 0 && current!.close >= current!.high - .25 * range);
  const rangeBars = contract.rangeHours?.map((hour) => candles.find((c) => c.time.slice(0, 10) === current?.time.slice(0, 10) && new Date(c.time).getUTCHours() === hour)) ?? [];
  const rangeOk = !contract.rangeHours || (ready && rangeBars.length === contract.rangeHours.length && rangeBars.every(Boolean) && current!.close > Math.max(...rangeBars.map((c) => c!.high)));
  const slopeOk = contract.rangeHours !== undefined && !contract.consensus ? Boolean(ema20 !== null && ema20Back !== null && ema20 > ema20Back) : true;
  const raw = Boolean(origin && ready && consensusOk && structureOk && prevHighOk && clearanceOk && reclaimOk && bodyExtremeOk && rangeOk && slopeOk);
  const correctSymbol = input.instrument === contract.symbol; const correctTimeframe = (options.timeframe ?? "H1") === "H1";
  const allowed = raw && correctSymbol && correctTimeframe && !options.hasActivePosition && !options.duplicateSignal;
  const entry = allowed ? contract.direction === "long" ? input.ask ?? current!.close : input.bid ?? current!.close : null;
  const stop = entry === null ? null : contract.direction === "long" ? entry - atr14! : entry + atr14!;
  const target = entry === null ? null : contract.direction === "long" ? entry + 2 * atr14! : entry - 2 * atr14!;
  const evaluatedAt = current ? new Date(Date.parse(current.time) + 3_600_000).toISOString() : input.evaluatedAt ?? new Date(0).toISOString();
  const gates = evaluateHardGates(input, evaluatedAt, completedCandles(input.candles15m), candles, completedCandles(input.candles4h));
  const conditions = [
    condition("Symbol", correctSymbol, `${contract.id} is restricted to ${contract.symbol}.`, input.instrument),
    condition("Timeframe", correctTimeframe, "Only completed H1 candles are eligible.", options.timeframe ?? "H1"),
    condition(`Completed ${String(contract.originHour).padStart(2, "0")}:00 UTC candle`, origin, "Only the frozen origin candle may signal.", current?.time ?? "unavailable"),
    condition("Frozen indicator history", ready, "EMA/ATR/history must be available and ATR positive.", ready ? "ready" : "unavailable"),
    condition("Frozen entry rules", raw, "The pair-specific frozen rule contract must qualify without substitutions.", raw ? "qualified" : "not qualified"),
    condition("No duplicate signal", !options.duplicateSignal, "This pair's UTC signal key can execute once.", options.duplicateSignal ? "duplicate" : "clear"),
    condition("No active pair position", !options.hasActivePosition, "Open state is keyed by strategy and symbol.", options.hasActivePosition ? "active" : "clear"),
    ...gates.conditions,
  ];
  return { family: contract.id, version: contract.version, configVersion: contract.configVersion, regime: regime(contract, evaluatedAt, atr14, ema20, ema50), qualifyReason: allowed ? `${contract.name} frozen rules qualified.` : "Frozen rules did not qualify or execution state blocks the signal.", status: allowed && gates.passed ? "valid" : "no_setup", instrument: input.instrument, pair: displayNameFor(input.instrument), direction: allowed && gates.passed ? contract.direction : null, timeframe: "1h", entry: allowed && gates.passed ? entry : null, stop: allowed && gates.passed ? stop : null, target: allowed && gates.passed ? target : null, riskReward: allowed && gates.passed ? 2 : null, positionSize: null, features: { trend15m: "mixed", trend1h: contract.direction === "long" ? "bullish" : "bearish", trend4h: null, ema21: null, ema50, ema200: null, rsi14: null, atr14, atrPips: atr14 === null ? null : atr14 / pipSizeFor(contract.symbol), structureHighs: 0, structureLows: 0, evaluationMode: input.evaluationMode ?? "live", newsStatus: gates.newsStatus, frozenPairStrategy: { strategyId: contract.id, strategyName: contract.name, strategyVersion: contract.version, symbol: contract.symbol, timeframe: "H1", signalKey: raw && current ? `${contract.id}:${current.time}` : null, originHourUtc: contract.originHour, frozenAtr14: raw ? atr14 : null, maxHoldBars: 3, actualExit: null, exitTimeUtc: null, exitReason: null, realizedR: null } }, summary: allowed ? `${contract.name} ${contract.direction.toUpperCase()} signal.` : `${contract.name} WAIT.`, conditions, passedConditions: conditions.filter((item) => item.passed), failedConditions: conditions.filter((item) => !item.passed), evaluatedAt, dataSource: input.dataSource };
}
