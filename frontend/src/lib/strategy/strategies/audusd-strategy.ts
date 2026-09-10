import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues } from "@/lib/strategy/indicators";
import { completedCandles, evaluateHardGates } from "@/lib/strategy/strategy-common";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type {
  AudusdStrategyFeatures, MarketRegime, PairStrategyId, StrategyCondition, StrategyEvaluationInput,
} from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * Frozen AUDUSD Strong Consensus Structure V2. Every rule and threshold in this
 * module is literal; any future change must use a new strategy version.
 */
export const AUDUSD_STRATEGY_ID = "audusd_strategy" as const;
export const AUDUSD_STRATEGY_NAME = "AUDUSD Strong Consensus Structure V2 HL Only" as const;
export const AUDUSD_STRATEGY_VERSION = "AUDUSD_STRONG_CONS_STRUCTURE_V2" as const;
export const AUDUSD_STRATEGY_CONFIG_VERSION = "audusd-strategy-cfg-v2-hl-only" as const;
export const AUDUSD_STRATEGY_SYMBOL = "AUD_USD" as const;
export const AUDUSD_STRATEGY_TIMEFRAME = "H1" as const;
export const AUDUSD_STRATEGY_ORIGIN = "11:00 UTC" as const;

export const AUDUSD_EMA_FAST = 20;
export const AUDUSD_EMA_SLOW = 50;
export const AUDUSD_ATR_LENGTH = 14;
export const AUDUSD_PRE_RANGE_START_UTC = 6;
export const AUDUSD_PRE_RANGE_END_UTC = 10;
export const AUDUSD_SIGNAL_ORIGIN_UTC = 11;
export const AUDUSD_MIN_VOTE_SUM = 4;
export const AUDUSD_BODY_ATR_MIN = 0.50;
export const AUDUSD_EXTREME_CLOSE_PCT = 0.25;
export const AUDUSD_STOP_ATR_MULTIPLIER = 1.0;
export const AUDUSD_REWARD_R = 2.0;
export const AUDUSD_MAX_HOLD_BARS = 3;

export const AUDUSD_STRATEGY_CONFIG = Object.freeze({
  symbol: AUDUSD_STRATEGY_SYMBOL,
  timeframe: AUDUSD_STRATEGY_TIMEFRAME,
  direction: "LONG",
  emaFastPeriod: AUDUSD_EMA_FAST,
  emaSlowPeriod: AUDUSD_EMA_SLOW,
  atrPeriod: AUDUSD_ATR_LENGTH,
  preRangeStartUtcHour: AUDUSD_PRE_RANGE_START_UTC,
  preRangeEndUtcHour: AUDUSD_PRE_RANGE_END_UTC,
  signalOriginUtcHour: AUDUSD_SIGNAL_ORIGIN_UTC,
  minimumVoteSum: AUDUSD_MIN_VOTE_SUM,
  requiredStructure: "HL_ONLY_EXTERNAL",
  stopAtr: AUDUSD_STOP_ATR_MULTIPLIER,
  rewardR: AUDUSD_REWARD_R,
  maxHoldBars: AUDUSD_MAX_HOLD_BARS,
  confidenceTagOnly: true,
  bodyAtrMinimum: AUDUSD_BODY_ATR_MIN,
  extremeClosePct: AUDUSD_EXTREME_CLOSE_PCT,
});

export type AudusdVote = -1 | 0 | 1;

export type AudusdStrategyWaitReason =
  | "WRONG_SYMBOL"
  | "WRONG_TIMEFRAME"
  | "NOT_1100_UTC"
  | "ORIGIN_NOT_COMPLETE"
  | "MALFORMED_CANDLES"
  | "MISSING_0600_CANDLE"
  | "MISSING_0700_CANDLE"
  | "MISSING_0800_CANDLE"
  | "MISSING_0900_CANDLE"
  | "MISSING_1000_CANDLE"
  | "EMA20_UNAVAILABLE"
  | "EMA50_UNAVAILABLE"
  | "ATR14_UNAVAILABLE"
  | "ATR_INVALID"
  | "VOTE_SUM_TOO_LOW"
  | "BULL_STRUCTURE_FAILED"
  | "DUPLICATE_SIGNAL"
  | "POSITION_ALREADY_OPEN"
  | "NUMERICAL_SAFETY";

export interface AudusdVoteInput {
  ema20: number;
  ema50: number;
  close: number;
  ema20At0800: number;
  preRangeMid: number;
  signalHigh: number;
  signalLow: number;
  priorHigh: number;
  priorLow: number;
  close0800: number;
}
export interface AudusdVoteResult {
  emaVote: AudusdVote;
  priceEmaVote: AudusdVote;
  emaSlopeVote: AudusdVote;
  rangeVote: AudusdVote;
  structureVote: AudusdVote;
  momentumVote: AudusdVote;
  voteSum: number;
  bullStructure: boolean;
  higherLow: boolean;
}

export interface AudusdStrategyTraceRow extends AudusdVoteResult {
  timestamp: string;
  signalTimeUtc: string;
  signalKey: string;
  preRangeHigh: number | null;
  preRangeLow: number | null;
  preRangeMid: number | null;
  missingRangeHours: number[];
  ema20: number | null;
  ema50: number | null;
  ema20At0800: number | null;
  close0800: number | null;
  atr14: number | null;
  candleBody: number;
  bodyAtrRatio: number | null;
  bodyConfirm: boolean;
  candleRange: number;
  extremeClose: boolean;
  confidenceTag: "AUDUSD_BODY_EXTREME" | "AUDUSD_BASE";
  finalLongSignal: boolean;
  signalClose: number | null;
  stop: number | null;
  target: number | null;
  expirationTimeUtc: string;
}

export interface AudusdStrategyEvaluationOptions {
  timeframe?: string;
  hasActivePosition?: boolean;
  duplicateSignal?: boolean;
  onDebug?: (features: AudusdStrategyFeatures) => void;
}

function finite(value: number) {
  return Number.isFinite(value);
}

function validCandle(candle: Candle) {
  const timestamp = Date.parse(candle.time);
  return Number.isFinite(timestamp)
    && finite(candle.open) && finite(candle.high) && finite(candle.low) && finite(candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low;
}

function sameCandle(left: Candle, right: Candle) {
  return left.open === right.open && left.high === right.high && left.low === right.low
    && left.close === right.close && left.complete === right.complete;
}

function isExactH1Start(date: Date) {
  return date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

function utcDay(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function compare(left: number, right: number): AudusdVote {
  return left > right ? 1 : left < right ? -1 : 0;
}

/** The six frozen votes and HH+HL structure requirement, calculated in one place. */
export function evaluateAudusdVotes(input: AudusdVoteInput): AudusdVoteResult {
  const emaVote = compare(input.ema20, input.ema50);
  const priceEmaVote = compare(input.close, input.ema20);
  const emaSlopeVote = compare(input.ema20, input.ema20At0800);
  const rangeVote = compare(input.close, input.preRangeMid);
  const bullStructure = input.signalHigh > input.priorHigh && input.signalLow > input.priorLow;
  const bearStructure = input.signalHigh < input.priorHigh && input.signalLow < input.priorLow;
  const structureVote: AudusdVote = bullStructure ? 1 : bearStructure ? -1 : 0;
  const momentumVote = compare(input.close, input.close0800);
  return {
    emaVote, priceEmaVote, emaSlopeVote, rangeVote, structureVote, momentumVote,
    voteSum: emaVote + priceEmaVote + emaSlopeVote + rangeVote + structureVote + momentumVote,
    bullStructure,
    higherLow: input.signalLow > input.priorLow,
  };
}

/** V2 entry verdict. Vote #5 stays HH+HL, while the external filter is HL-only. */
export function audusdLongSignal(votes: Pick<AudusdVoteResult, "voteSum" | "higherLow">) {
  return votes.voteSum >= AUDUSD_MIN_VOTE_SUM && votes.higherLow;
}

/** Frozen 1 ATR stop / 2 ATR target geometry for the long-only strategy. */
export function audusdTradeGeometry(entry: number, entryATR: number) {
  return {
    stopLoss: entry - AUDUSD_STOP_ATR_MULTIPLIER * entryATR,
    takeProfit: entry + AUDUSD_REWARD_R * entryATR,
  };
}

/** Pine ta.ema recurrence: the first completed source value seeds the EMA. */
export function calculateAudusdEmaValues(closes: readonly number[], period: number) {
  const alpha = 2 / (period + 1);
  let previous: number | null = null;
  return closes.map((close) => {
    previous = previous === null ? close : alpha * close + (1 - alpha) * previous;
    return previous;
  });
}

/** Completed H1 bars only, sorted ascending; conflicting duplicate bars fail closed. */
export function normalizeAudusdH1Candles(candles: readonly Candle[]) {
  const completed = candles.filter((candle) => candle.complete);
  if (completed.some((candle) => !validCandle(candle))) {
    return { candles: [] as Candle[], error: "Completed H1 history contains a malformed candle." };
  }
  const sorted = [...completed].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const unique: Candle[] = [];
  for (const candle of sorted) {
    const prior = unique.at(-1);
    if (!prior || Date.parse(prior.time) !== Date.parse(candle.time)) {
      unique.push(candle);
    } else if (!sameCandle(prior, candle)) {
      return { candles: [] as Candle[], error: `Conflicting H1 candles share timestamp ${candle.time}.` };
    }
  }
  return { candles: unique, error: null as string | null };
}

const EMPTY_VOTES: AudusdVoteResult = {
  emaVote: 0, priceEmaVote: 0, emaSlopeVote: 0, rangeVote: 0,
  structureVote: 0, momentumVote: 0, voteSum: 0, bullStructure: false, higherLow: false,
};

/**
 * Causal trace over completed H1 candles. OANDA timestamps are candle starts;
 * the 11:00 origin becomes actionable at 12:00 UTC.
 */
export function evaluateAudusdStrategyTrace(candles: readonly Candle[]): { rows: AudusdStrategyTraceRow[]; error: string | null } {
  const normalized = normalizeAudusdH1Candles(candles);
  if (normalized.error) return { rows: [], error: normalized.error };
  const values = normalized.candles;
  const ema20Values = calculateAudusdEmaValues(values.map((candle) => candle.close), AUDUSD_EMA_FAST);
  const ema50Values = calculateAudusdEmaValues(values.map((candle) => candle.close), AUDUSD_EMA_SLOW);
  const atr14Values = calculateAtrValues(values, AUDUSD_ATR_LENGTH);
  const rows: AudusdStrategyTraceRow[] = [];
  let currentDay: string | null = null;
  let dayBars = new Map<number, { candle: Candle; index: number }>();

  for (let index = 0; index < values.length; index += 1) {
    const candle = values[index]!;
    const date = new Date(candle.time);
    const day = utcDay(candle.time);
    if (day !== currentDay) {
      currentDay = day;
      dayBars = new Map();
    }
    if (isExactH1Start(date)) dayBars.set(date.getUTCHours(), { candle, index });

    const missingRangeHours = [6, 7, 8, 9, 10].filter((hour) => !dayBars.has(hour));
    const rangeBars = [6, 7, 8, 9, 10].map((hour) => dayBars.get(hour)?.candle).filter((bar): bar is Candle => Boolean(bar));
    const preRangeHigh = missingRangeHours.length ? null : Math.max(...rangeBars.map((bar) => bar.high));
    const preRangeLow = missingRangeHours.length ? null : Math.min(...rangeBars.map((bar) => bar.low));
    const preRangeMid = preRangeHigh === null || preRangeLow === null ? null : (preRangeHigh + preRangeLow) / 2;
    const bar0800 = dayBars.get(8);
    const bar1000 = dayBars.get(10);
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const ema20At0800 = bar0800 ? ema20Values[bar0800.index] ?? null : null;
    const close0800 = bar0800?.candle.close ?? null;
    const atr14 = atr14Values[index] ?? null;
    const historyContinuous = isExactH1Start(date) && date.getUTCHours() === AUDUSD_SIGNAL_ORIGIN_UTC
      && index >= 5 && Date.parse(candle.time) - Date.parse(values[index - 5]!.time) === 5 * 60 * 60_000
      && new Date(values[index - 5]!.time).getUTCHours() === 6;
    const voteInputsAvailable = historyContinuous && missingRangeHours.length === 0 && ema20 !== null && ema50 !== null && ema20At0800 !== null
      && close0800 !== null && preRangeMid !== null && Boolean(bar1000);
    const votes = voteInputsAvailable ? evaluateAudusdVotes({
      ema20, ema50, close: candle.close, ema20At0800, preRangeMid,
      signalHigh: candle.high, signalLow: candle.low,
      priorHigh: bar1000!.candle.high, priorLow: bar1000!.candle.low, close0800,
    }) : EMPTY_VOTES;
    const candleBody = Math.abs(candle.close - candle.open);
    const bodyAtrRatio = atr14 !== null && atr14 > 0 ? candleBody / atr14 : null;
    const bodyConfirm = atr14 !== null && atr14 > 0 && candleBody >= AUDUSD_BODY_ATR_MIN * atr14;
    const candleRange = candle.high - candle.low;
    const extremeClose = candleRange > 0 && candle.close >= candle.high - candleRange * AUDUSD_EXTREME_CLOSE_PCT;
    const confidenceTag = bodyConfirm && extremeClose ? "AUDUSD_BODY_EXTREME" as const : "AUDUSD_BASE" as const;
    const isOrigin = isExactH1Start(date) && date.getUTCHours() === AUDUSD_SIGNAL_ORIGIN_UTC;
    const finalLongSignal = isOrigin && historyContinuous && missingRangeHours.length === 0 && voteInputsAvailable && atr14 !== null && atr14 > 0
      && finite(atr14) && audusdLongSignal(votes);
    const signalClose = finalLongSignal ? candle.close : null;
    const geometry = signalClose === null || atr14 === null ? null : audusdTradeGeometry(signalClose, atr14);
    const stop = geometry?.stopLoss ?? null;
    const target = geometry?.takeProfit ?? null;
    const signalTimeUtc = new Date(Date.parse(candle.time) + 60 * 60_000).toISOString();

    rows.push({
      timestamp: candle.time,
      signalTimeUtc,
      signalKey: `AUDUSD-${day}-1100`,
      preRangeHigh, preRangeLow, preRangeMid, missingRangeHours,
      ema20, ema50, ema20At0800, close0800, atr14,
      ...votes,
      candleBody, bodyAtrRatio, bodyConfirm, candleRange, extremeClose, confidenceTag,
      finalLongSignal, signalClose, stop, target,
      expirationTimeUtc: new Date(Date.parse(signalTimeUtc) + AUDUSD_MAX_HOLD_BARS * 60 * 60_000).toISOString(),
    });
  }
  return { rows, error: null };
}

function condition(name: string, passed: boolean, reason: string, currentValue: string): StrategyCondition {
  return { name, passed, required: true, reason, currentValue };
}

function missingReason(hour: number): AudusdStrategyWaitReason {
  return `MISSING_${String(hour).padStart(2, "0")}00_CANDLE` as AudusdStrategyWaitReason;
}

function waitReasonFor(trace: AudusdStrategyTraceRow, candle: Candle): AudusdStrategyWaitReason | null {
  const date = new Date(candle.time);
  if (!isExactH1Start(date) || date.getUTCHours() !== AUDUSD_SIGNAL_ORIGIN_UTC) return "NOT_1100_UTC";
  if (trace.missingRangeHours.length) return missingReason(trace.missingRangeHours[0]!);
  if (trace.ema20 === null) return "EMA20_UNAVAILABLE";
  if (trace.ema50 === null) return "EMA50_UNAVAILABLE";
  if (trace.ema20At0800 === null || trace.close0800 === null) return "MISSING_0800_CANDLE";
  if (trace.atr14 === null) return "ATR14_UNAVAILABLE";
  if (!finite(trace.atr14) || !(trace.atr14 > 0)) return "ATR_INVALID";
  if (trace.voteSum < AUDUSD_MIN_VOTE_SUM) return "VOTE_SUM_TOO_LOW";
  // V2's final external structure gate is HL-only. The full HH+HL check is
  // retained solely inside vote #5 and must not reject a +4-or-better setup.
  if (!trace.higherLow) return "BULL_STRUCTURE_FAILED";
  return null;
}

function emptyRegime(evaluatedAt: string, trace: AudusdStrategyTraceRow | undefined): MarketRegime {
  const pip = pipSizeFor(AUDUSD_STRATEGY_SYMBOL);
  return {
    regime: "mixed",
    trendDirection: trace && trace.emaVote > 0 ? "up" : trace && trace.emaVote < 0 ? "down" : "none",
    trendStrength: 0,
    volatility: "normal",
    atr: trace?.atr14 ?? null,
    atrPips: trace?.atr14 == null ? null : trace.atr14 / pip,
    momentumState: "steady",
    emaFast: trace?.ema20 ?? null,
    emaMid: trace?.ema50 ?? null,
    emaSlow: null,
    slopeAtrPerBar: trace?.atr14 && trace.ema20 !== null && trace.ema20At0800 !== null
      ? (trace.ema20 - trace.ema20At0800) / 3 / trace.atr14 : null,
    rangeHigh: trace?.preRangeHigh ?? null,
    rangeLow: trace?.preRangeLow ?? null,
    rangeWidthAtr: trace?.atr14 && trace.preRangeHigh !== null && trace.preRangeLow !== null
      ? (trace.preRangeHigh - trace.preRangeLow) / trace.atr14 : null,
    rangeAgeBars: null,
    lookbackBars: AUDUSD_EMA_SLOW,
    evaluatedAt,
  };
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Evaluate only the latest completed 11:00 UTC H1 origin. Shorts are impossible. */
export function evaluateAudusdStrategy(
  input: StrategyEvaluationInput,
  options: AudusdStrategyEvaluationOptions = {},
): StrategyCandidate<PairStrategyId> {
  const timeframe = options.timeframe ?? AUDUSD_STRATEGY_TIMEFRAME;
  const normalized = normalizeAudusdH1Candles(input.candles1h);
  const traced = normalized.error ? { rows: [] as AudusdStrategyTraceRow[], error: normalized.error }
    : evaluateAudusdStrategyTrace(normalized.candles);
  const lastCandle = normalized.candles.at(-1);
  const trace = traced.rows.at(-1);
  const rawLatest = [...input.candles1h].sort((left, right) => Date.parse(left.time) - Date.parse(right.time)).at(-1);
  const formingOrigin = Boolean(rawLatest && !rawLatest.complete && isExactH1Start(new Date(rawLatest.time))
    && new Date(rawLatest.time).getUTCHours() === AUDUSD_SIGNAL_ORIGIN_UTC);
  const evaluatedAt = trace?.signalTimeUtc ?? input.evaluatedAt ?? new Date(0).toISOString();
  const executionGates = evaluateHardGates(
    input, evaluatedAt, completedCandles(input.candles15m), normalized.candles, completedCandles(input.candles4h),
  );
  let waitReason: AudusdStrategyWaitReason | null = null;

  if (input.instrument !== AUDUSD_STRATEGY_SYMBOL) waitReason = "WRONG_SYMBOL";
  else if (timeframe !== AUDUSD_STRATEGY_TIMEFRAME) waitReason = "WRONG_TIMEFRAME";
  else if (formingOrigin) waitReason = "ORIGIN_NOT_COMPLETE";
  else if (normalized.error || traced.error) waitReason = "MALFORMED_CANDLES";
  else if (!lastCandle || !trace) waitReason = "ORIGIN_NOT_COMPLETE";
  else waitReason = waitReasonFor(trace, lastCandle);
  if (waitReason === null && options.duplicateSignal) waitReason = "DUPLICATE_SIGNAL";
  if (waitReason === null && options.hasActivePosition) waitReason = "POSITION_ALREADY_OPEN";

  const rawDirection = waitReason === null && trace?.finalLongSignal ? "long" as const : null;
  // Pine uses process_orders_on_close, so the frozen entry and its geometry are
  // the completed 11:00 UTC signal candle close. A later live ASK must never
  // rewrite a Pine-parity signal.
  const intendedEntry = rawDirection ? trace?.signalClose ?? null : null;
  const riskDistance = rawDirection && trace?.atr14 != null ? trace.atr14 * AUDUSD_STOP_ATR_MULTIPLIER : null;
  const geometry = intendedEntry === null || trace?.atr14 == null ? null : audusdTradeGeometry(intendedEntry, trace.atr14);
  const stop = geometry?.stopLoss ?? null;
  const target = geometry?.takeProfit ?? null;
  const numericalSafety = rawDirection !== null && finitePositive(intendedEntry) && finitePositive(riskDistance)
    && finitePositive(stop) && finitePositive(target) && stop < intendedEntry && intendedEntry < target;
  if (rawDirection && !numericalSafety) waitReason = "NUMERICAL_SAFETY";
  const direction = waitReason === null && numericalSafety ? rawDirection : null;
  const finalEntry = direction ? intendedEntry : null;
  const finalStop = direction ? stop : null;
  const finalTarget = direction ? target : null;
  const signalReason = direction
    ? `AUDUSD LONG: six-vote sum ${trace!.voteSum} meets +4 and the completed 11:00 UTC candle has the required external higher low.`
    : `WAIT: ${waitReason ?? "VOTE_SUM_TOO_LOW"}.`;

  const features: AudusdStrategyFeatures = {
    strategyId: AUDUSD_STRATEGY_ID,
    strategyName: AUDUSD_STRATEGY_NAME,
    strategyVersion: AUDUSD_STRATEGY_VERSION,
    symbol: AUDUSD_STRATEGY_SYMBOL,
    timeframe: AUDUSD_STRATEGY_TIMEFRAME,
    origin: AUDUSD_STRATEGY_ORIGIN,
    direction: direction ? "LONG" : null,
    signalKey: direction && trace ? trace.signalKey : null,
    signalCandleTimestamp: trace?.timestamp ?? null,
    signalTimeUtc: trace?.signalTimeUtc ?? null,
    entryTimeUtc: direction ? trace?.signalTimeUtc ?? null : null,
    signalClose: direction ? trace?.signalClose ?? null : null,
    intendedEntry: finalEntry,
    actualEntry: null,
    ema20: trace?.ema20 ?? null,
    ema50: trace?.ema50 ?? null,
    ema20At0800: trace?.ema20At0800 ?? null,
    close0800: trace?.close0800 ?? null,
    preRangeHigh: trace?.preRangeHigh ?? null,
    preRangeLow: trace?.preRangeLow ?? null,
    preRangeMid: trace?.preRangeMid ?? null,
    emaVote: trace?.emaVote ?? 0,
    priceEmaVote: trace?.priceEmaVote ?? 0,
    emaSlopeVote: trace?.emaSlopeVote ?? 0,
    rangeVote: trace?.rangeVote ?? 0,
    structureVote: trace?.structureVote ?? 0,
    momentumVote: trace?.momentumVote ?? 0,
    voteSum: trace ? trace.voteSum : null,
    bullStructure: trace?.bullStructure ?? false,
    atr14: trace?.atr14 ?? null,
    entryATR: direction ? trace?.atr14 ?? null : null,
    candleBody: trace?.candleBody ?? null,
    bodyAtrRatio: trace?.bodyAtrRatio ?? null,
    bodyConfirm: trace?.bodyConfirm ?? false,
    candleRange: trace?.candleRange ?? null,
    extremeClose: trace?.extremeClose ?? false,
    confidenceTag: direction ? trace?.confidenceTag ?? null : null,
    stopLoss: finalStop,
    takeProfit: finalTarget,
    maximumHoldBars: AUDUSD_MAX_HOLD_BARS,
    expirationTimeUtc: direction ? trace?.expirationTimeUtc ?? null : null,
    actualExit: null,
    exitTimeUtc: null,
    exitReason: null,
    realizedPnL: null,
    realizedR: null,
    brokerOrderId: null,
    brokerTradeId: null,
    waitReason,
  };
  options.onDebug?.(features);

  const conditions: StrategyCondition[] = [
    condition("Symbol", input.instrument === AUDUSD_STRATEGY_SYMBOL, "audusd_strategy is restricted to AUD_USD.", input.instrument),
    condition("Timeframe", timeframe === AUDUSD_STRATEGY_TIMEFRAME, "Only H1 candles are eligible.", timeframe),
    condition("Completed 11:00 UTC candle", Boolean(lastCandle && !formingOrigin && isExactH1Start(new Date(lastCandle.time)) && new Date(lastCandle.time).getUTCHours() === 11), "The completed H1 candle stamped 11:00 UTC is the sole origin.", formingOrigin ? "forming" : lastCandle?.time ?? "unavailable"),
    condition("06:00-10:00 UTC range", Boolean(trace && trace.missingRangeHours.length === 0), "All five range candles are required and 11:00 is excluded.", trace?.missingRangeHours.length ? `missing ${trace.missingRangeHours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")}` : "5/5"),
    condition("EMA20 available", trace?.ema20 != null, "EMA20 must be available from completed H1 closes.", trace?.ema20?.toString() ?? "unavailable"),
    condition("EMA50 available", trace?.ema50 != null, "EMA50 must be available from completed H1 closes.", trace?.ema50?.toString() ?? "unavailable"),
    condition("Wilder ATR14", Boolean(trace?.atr14 != null && finite(trace.atr14) && trace.atr14 > 0), "ATR14 must be finite and positive.", trace?.atr14?.toString() ?? "unavailable"),
    condition("Strong consensus", Boolean(trace && trace.voteSum >= AUDUSD_MIN_VOTE_SUM), "The six-vote sum must be at least +4; bearish consensus never creates a short.", trace?.voteSum.toString() ?? "unavailable"),
    condition("V2 external higher-low structure", trace?.higherLow ?? false, "Final V2 gate requires only low > low[1]; vote #5 retains HH+HL/LH+LL.", trace?.higherLow ? "passed" : "failed"),
    condition("No duplicate signal", !options.duplicateSignal, "The deterministic UTC-day signal key may execute only once.", options.duplicateSignal ? "duplicate" : "clear"),
    condition("No active strategy position", !options.hasActivePosition, "Pyramiding is disabled for audusd_strategy.", options.hasActivePosition ? "active" : "clear"),
    condition("Numerical safety", direction ? numericalSafety : true, "Entry, frozen ATR, stop, and target must be finite and ordered.", direction ? "valid" : "not applicable"),
  ];
  const allConditions = [...conditions, ...executionGates.conditions];
  return {
    family: AUDUSD_STRATEGY_ID,
    version: AUDUSD_STRATEGY_VERSION,
    configVersion: AUDUSD_STRATEGY_CONFIG_VERSION,
    regime: emptyRegime(evaluatedAt, trace),
    qualifyReason: signalReason,
    status: direction ? "valid" : waitReason === "MALFORMED_CANDLES" ? "invalid" : "no_setup",
    instrument: input.instrument,
    pair: displayNameFor(input.instrument),
    direction,
    timeframe: "1h",
    entry: finalEntry,
    stop: finalStop,
    target: finalTarget,
    riskReward: direction ? AUDUSD_REWARD_R : null,
    positionSize: null,
    features: {
      trend15m: "mixed",
      trend1h: trace && trace.emaVote > 0 ? "bullish" : trace && trace.emaVote < 0 ? "bearish" : "mixed",
      trend4h: null,
      ema21: null,
      ema50: trace?.ema50 ?? null,
      ema200: null,
      rsi14: null,
      atr14: trace?.atr14 ?? null,
      atrPips: trace?.atr14 == null ? null : trace.atr14 / pipSizeFor(AUDUSD_STRATEGY_SYMBOL),
      structureHighs: trace?.bullStructure ? 1 : 0,
      structureLows: trace?.bullStructure ? 1 : 0,
      evaluationMode: input.evaluationMode ?? "live",
      newsStatus: executionGates.newsStatus,
      audusdStrategy: features,
    },
    summary: direction ? signalReason : `${displayNameFor(input.instrument)} ${signalReason}`,
    passedConditions: allConditions.filter((item) => item.passed),
    failedConditions: allConditions.filter((item) => !item.passed),
    conditions: allConditions,
    evaluatedAt,
    dataSource: input.dataSource,
  };
}

export interface AudusdExitQuote {
  closeTime: string;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
}

export interface AudusdExitResult {
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

/** Exactly three future completed H1 bars; same-bar ambiguity resolves to SL. */
export function resolveAudusdExit(input: {
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
  quotes: readonly AudusdExitQuote[];
  now: Date;
}): AudusdExitResult | null {
  const decisionMs = Date.parse(input.decisionTime);
  const horizonMs = decisionMs + AUDUSD_MAX_HOLD_BARS * 60 * 60_000;
  const horizonEndsAt = new Date(horizonMs).toISOString();
  const risk = input.entry - input.stop;
  if (!Number.isFinite(decisionMs) || !(risk > 0) || !(input.target > input.entry)) return null;
  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;
  let horizonQuote: AudusdExitQuote | null = null;
  const quotes = [...input.quotes].sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
  for (const quote of quotes) {
    const quoteMs = Date.parse(quote.closeTime);
    if (!(quoteMs > decisionMs) || quoteMs > horizonMs) continue;
    if (quoteMs === horizonMs) horizonQuote = quote;
    const favorable = (quote.bidHigh - input.entry) / risk;
    const adverse = (input.entry - quote.bidLow) / risk;
    maxFavorableR = Math.max(maxFavorableR ?? favorable, favorable);
    maxAdverseR = Math.max(maxAdverseR ?? adverse, adverse);
    const targetHit = quote.bidHigh >= input.target;
    const stopHit = quote.bidLow <= input.stop;
    const barsHeld = Math.max(1, Math.ceil((quoteMs - decisionMs) / (60 * 60_000)));
    if (stopHit) {
      return { outcome: "stop_first", exitReason: "SL", exit: input.stop, resultR: -1, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld, maxFavorableR, maxAdverseR };
    }
    if (targetHit) {
      return { outcome: "target_first", exitReason: "TP", exit: input.target, resultR: AUDUSD_REWARD_R, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld, maxFavorableR, maxAdverseR };
    }
  }
  if (input.now.getTime() < horizonMs || !horizonQuote) return null;
  const resultR = (horizonQuote.bidClose - input.entry) / risk;
  return {
    outcome: "time_exit", exitReason: "TIME_EXIT", exit: horizonQuote.bidClose, resultR,
    resolvedAt: horizonQuote.closeTime, horizonEndsAt, barsHeld: AUDUSD_MAX_HOLD_BARS,
    maxFavorableR, maxAdverseR,
  };
}
