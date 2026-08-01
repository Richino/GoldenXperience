import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { evaluateStructure } from "@/lib/strategy/market-structure";
import { calculateAtrValues, calculateEmaValues, calculateRsiValues } from "@/lib/strategy/indicators";
import type { StrategyCondition, StrategyEvaluationBundle, StrategyEvaluationInput, StrategySetup } from "@/lib/strategy/types";
import { calculatePositionSize, DEFAULT_RISK_POLICY } from "@/lib/risk/engine";

const MINIMUM_CANDLES = 210;
const MINIMUM_RISK_REWARD = 2;
/** The only strategy permitted to create new Signals and research evaluations. */
export const ACTIVE_STRATEGY_VERSION = "day-intraday-v1";
export const DAY_TRADING_TIME_ZONE = "America/New_York";
export const DAY_ENTRY_START_MINUTES = 3 * 60;
export const DAY_ENTRY_END_MINUTES = 12 * 60;
export const DAY_FORCED_EXIT_MINUTES = 16 * 60 + 45;
const MAX_SPREAD_PIPS: Record<string, number> = {
  EUR_USD: 1.5,
  GBP_USD: 2,
  USD_JPY: 1.5,
};

type Trend = "bullish" | "bearish" | "mixed";

function condition(name: string, passed: boolean, reason: string, currentValue: string, required = true): StrategyCondition {
  return { name, passed, required, reason, currentValue };
}

function completed(candles: StrategyEvaluationInput["candles15m"]) {
  return candles.filter((candle) => candle.complete);
}

function trendFor(candles: StrategyEvaluationInput["candles15m"]): { trend: Trend; ema21: number | null; ema50: number | null; ema200: number | null } {
  const closes = candles.map((candle) => candle.close);
  const ema21 = calculateEmaValues(closes, 21).at(-1) ?? null;
  const ema50 = calculateEmaValues(closes, 50).at(-1) ?? null;
  const ema200 = calculateEmaValues(closes, 200).at(-1) ?? null;
  if (ema21 === null || ema50 === null || ema200 === null) return { trend: "mixed", ema21, ema50, ema200 };
  if (ema21 > ema50 && ema50 > ema200) return { trend: "bullish", ema21, ema50, ema200 };
  if (ema21 < ema50 && ema50 < ema200) return { trend: "bearish", ema21, ema50, ema200 };
  return { trend: "mixed", ema21, ema50, ema200 };
}

function formatNumber(value: number | null, digits = 5) {
  return value === null ? "unavailable" : value.toFixed(digits);
}

export function dayTradingSession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: DAY_TRADING_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const totalMinutes = hour * 60 + minute;
  // London 03:00–12:00, New York 08:00–17:00 Eastern.
  if (totalMinutes < DAY_ENTRY_START_MINUTES || totalMinutes >= DAY_ENTRY_END_MINUTES) return { open: false, label: "Outside day-trading entry window" };
  return { open: true, label: totalMinutes >= 8 * 60 ? "London/New York overlap" : "London" };
}

function confirmationCandle(candles: StrategyEvaluationInput["candles15m"], direction: "long" | "short", atr: number, ema21: number, ema50: number, swingPrice: number | null) {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!current || !previous) return { passed: false, reason: "Two completed candles are required." };
  const body = Math.abs(current.close - current.open);
  const zoneLow = Math.min(ema21, ema50);
  const zoneHigh = Math.max(ema21, ema50);
  const touchedZone = current.low <= zoneHigh && current.high >= zoneLow;
  if (direction === "long") {
    const engulfing = previous.close < previous.open && current.close > current.open && current.close >= previous.open && current.open <= previous.close;
    const continuation = current.close > previous.high && body >= atr * 0.45;
    const breakOfStructure = swingPrice !== null && current.close > swingPrice;
    const rejection = touchedZone && current.close > current.open && current.close >= current.high - (current.high - current.low) * 0.35;
    return { passed: engulfing || continuation || breakOfStructure || rejection, reason: engulfing ? "Bullish engulfing candle." : continuation ? "Strong bullish continuation candle." : breakOfStructure ? "Closed above a recent swing high." : rejection ? "Bullish rejection from the EMA zone." : "No completed bullish confirmation candle." };
  }
  const engulfing = previous.close > previous.open && current.close < current.open && current.close <= previous.open && current.open >= previous.close;
  const continuation = current.close < previous.low && body >= atr * 0.45;
  const breakOfStructure = swingPrice !== null && current.close < swingPrice;
  const rejection = touchedZone && current.close < current.open && current.close <= current.low + (current.high - current.low) * 0.35;
  return { passed: engulfing || continuation || breakOfStructure || rejection, reason: engulfing ? "Bearish engulfing candle." : continuation ? "Strong bearish continuation candle." : breakOfStructure ? "Closed below a recent swing low." : rejection ? "Bearish rejection from the EMA zone." : "No completed bearish confirmation candle." };
}

function chooseStatus(conditions: StrategyCondition[], trend: Trend): StrategySetup["status"] {
  if (conditions.some((item) => item.name === "Market data" && !item.passed)) return "invalid";
  if (trend === "mixed") return "no_setup";
  const hardRejected = conditions.some((item) => item.required && !item.passed && ["Higher timeframe alignment", "Spread", "Session", "News", "Momentum", "Volatility"].includes(item.name));
  if (hardRejected) return "invalid";
  if (conditions.every((item) => !item.required || item.passed)) return "valid";
  return "developing";
}

export function evaluateStrategy(input: StrategyEvaluationInput): StrategySetup {
  const candles15m = completed(input.candles15m);
  const candles1h = completed(input.candles1h);
  const candles4h = completed(input.candles4h);
  const conditions: StrategyCondition[] = [];
  const hasData = input.dataSource === "oanda" && candles15m.length >= MINIMUM_CANDLES && candles1h.length >= MINIMUM_CANDLES && candles4h.length >= MINIMUM_CANDLES;
  conditions.push(condition("Market data", hasData, hasData ? "Completed OANDA candles are available for all required timeframes." : "Live OANDA candle history is unavailable or incomplete.", `${candles15m.length}/${candles1h.length}/${candles4h.length} completed candles`));

  if (!hasData) {
    return finalize(input, null, conditions, "invalid", "Live OANDA candle history is required before a strategy decision.");
  }

  const primary = trendFor(candles15m);
  const oneHour = trendFor(candles1h);
  const fourHour = trendFor(candles4h);
  const direction = primary.trend === "bullish" ? "long" : primary.trend === "bearish" ? "short" : null;
  conditions.push(condition("EMA alignment", direction !== null, direction === "long" ? "EMA21 > EMA50 > EMA200." : direction === "short" ? "EMA21 < EMA50 < EMA200." : "The EMA stack is mixed.", `15m: ${formatNumber(primary.ema21)} / ${formatNumber(primary.ema50)} / ${formatNumber(primary.ema200)}`));

  if (!direction) {
    return finalize(input, null, conditions, "no_setup", "No 15m EMA trend is established.");
  }

  const expectedTrend = direction === "long" ? "bullish" : "bearish";
  const higherAligned = oneHour.trend === expectedTrend && fourHour.trend !== (direction === "long" ? "bearish" : "bullish");
  conditions.push(condition("Higher timeframe alignment", higherAligned, higherAligned ? "1H agrees and 4H does not oppose the 15m direction." : "1H disagrees or 4H strongly opposes the 15m direction.", `1H ${oneHour.trend} · 4H ${fourHour.trend}`));

  const atr = calculateAtrValues(candles15m, 14).at(-1) ?? null;
  const rsi = calculateRsiValues(candles15m.map((candle) => candle.close), 14).at(-1) ?? null;
  const last = candles15m.at(-1)!;
  const ema21 = primary.ema21!;
  const ema50 = primary.ema50!;
  const ema200 = primary.ema200!;
  const atrPips = atr === null ? 0 : atr / pipSizeFor(input.instrument);
  const zoneDistance = atr === null ? 0 : atr * 0.35;
  const zoneLow = Math.min(ema21, ema50) - zoneDistance;
  const zoneHigh = Math.max(ema21, ema50) + zoneDistance;
  const touchedZone = last.low <= zoneHigh && last.high >= zoneLow;
  const preservedStructure = direction === "long" ? last.low > ema200 : last.high < ema200;
  const pullbackPassed = touchedZone && preservedStructure;
  conditions.push(condition("Pullback", pullbackPassed, pullbackPassed ? "Price pulled into the EMA21/50 zone without breaking the 200 EMA structure." : "Price is not in a valid EMA pullback zone or structure broke.", `close ${formatNumber(last.close)} · EMA zone ${formatNumber(zoneLow)}–${formatNumber(zoneHigh)}`));

  const structure = evaluateStructure(candles15m.slice(-80), direction);
  conditions.push(condition("Market structure", structure.passed, structure.reason, `${structure.swings.highs.length} highs · ${structure.swings.lows.length} lows`));
  const swingForConfirmation = direction === "long" ? structure.swings.highs.at(-1)?.price ?? null : structure.swings.lows.at(-1)?.price ?? null;
  const confirmation = atr === null ? { passed: false, reason: "ATR is unavailable." } : confirmationCandle(candles15m, direction, atr, ema21, ema50, swingForConfirmation);
  conditions.push(condition("Confirmation candle", confirmation.passed, confirmation.reason, `last completed close ${formatNumber(last.close)}`));

  const momentumPassed = rsi !== null && (direction === "long" ? rsi >= 45 && rsi <= 68 : rsi >= 32 && rsi <= 55);
  conditions.push(condition("Momentum", momentumPassed, momentumPassed ? "RSI supports the trend without being extended." : "RSI is missing, weak, or too extended for entry.", `RSI14 ${rsi?.toFixed(1) ?? "unavailable"}`));
  const volatilityPassed = atr !== null && atrPips >= 2;
  conditions.push(condition("Volatility", volatilityPassed, volatilityPassed ? "ATR is sufficient for a reasonable stop." : "ATR is too compressed for this 15m setup.", `ATR14 ${atrPips.toFixed(1)} pips`));

  const session = dayTradingSession(input.evaluatedAt ? new Date(input.evaluatedAt) : new Date());
  conditions.push(condition("Session", session.open && input.marketOpen, session.open && input.marketOpen ? `${session.label} entry window is active.` : "Entries are limited to 03:00 ET inclusive until 12:00 ET exclusive while the forex market is open.", session.label));
  const maxSpread = MAX_SPREAD_PIPS[input.instrument] ?? 1.5;
  const spreadPassed = input.spreadPips !== null && input.spreadPips <= maxSpread;
  conditions.push(condition("Spread", spreadPassed, spreadPassed ? "Live spread is within the pair limit." : input.spreadPips === null ? "A live spread is unavailable." : "Spread Too High", input.spreadPips === null ? "unavailable" : `${input.spreadPips.toFixed(1)} / ${maxSpread.toFixed(1)} pips`));
  const newsRequired = input.newsRequired ?? true;
  const newsPassed = input.calendarConnected && (input.highImpactNewsWithinMinutes === null || input.highImpactNewsWithinMinutes > 30);
  conditions.push(condition("News", newsPassed, !newsRequired ? "Not evaluated in price-only historical research." : !input.calendarConnected ? "Unavailable — the news provider cannot clear a trade." : newsPassed ? "No high-impact event is inside the 30-minute buffer." : "High-impact news is inside the 30-minute buffer.", !newsRequired ? "not evaluated" : input.highImpactNewsWithinMinutes === null ? "No upcoming high-impact event" : `${input.highImpactNewsWithinMinutes} minutes`, newsRequired));

  const stopBuffer = Math.max(atr ?? 0, pipSizeFor(input.instrument) * 4) * 0.2;
  const swingStop = direction === "long" ? structure.swings.lows.at(-1)?.price ?? last.low : structure.swings.highs.at(-1)?.price ?? last.high;
  const rawStop = direction === "long" ? Math.min(last.low, swingStop) - stopBuffer : Math.max(last.high, swingStop) + stopBuffer;
  const entry = direction === "long" ? input.ask : input.bid;
  const stopDistance = entry === null ? null : Math.abs(entry - rawStop);
  const minimumStop = Math.max((atr ?? 0) * 0.8, pipSizeFor(input.instrument) * 4);
  const stop = entry === null ? null : direction === "long" ? entry - Math.max(stopDistance ?? 0, minimumStop) : entry + Math.max(stopDistance ?? 0, minimumStop);
  const minimumTarget = entry === null || stop === null ? null : direction === "long" ? entry + Math.abs(entry - stop) * MINIMUM_RISK_REWARD : entry - Math.abs(entry - stop) * MINIMUM_RISK_REWARD;
  // A nearby opposing swing is a real obstacle, not a decorative chart mark.
  // If one exists before the 2R target, the setup must fail rather than pretend
  // that price has unobstructed room to the fixed target.
  const structuralTarget = entry === null ? null : direction === "long"
    ? structure.swings.highs.find((swing) => swing.price > entry)?.price ?? null
    : structure.swings.lows.find((swing) => swing.price < entry)?.price ?? null;
  const target = structuralTarget ?? minimumTarget;
  const position = entry !== null && stop !== null ? calculatePositionSize({ instrument: input.instrument, accountBalance: input.accountBalance, riskPercent: DEFAULT_RISK_POLICY.riskPercent, entry, stop }) : null;
  const riskReward = entry !== null && stop !== null && target !== null ? Math.abs(target - entry) / Math.abs(entry - stop) : null;
  const rewardPassed = riskReward !== null && riskReward >= MINIMUM_RISK_REWARD;
  conditions.push(condition("Risk reward", rewardPassed, rewardPassed ? `Target meets the ${MINIMUM_RISK_REWARD.toFixed(1)}R minimum.` : structuralTarget !== null ? "The nearest opposing swing does not leave enough room for the minimum reward-to-risk ratio." : "The calculated target does not meet the minimum reward-to-risk ratio.", riskReward === null ? "unavailable" : `${riskReward.toFixed(2)}R`));

  const status = chooseStatus(conditions, primary.trend);
  const summary = status === "valid" ? `${displayNameFor(input.instrument)} ${direction} EMA pullback is valid.` : status === "developing" ? `${displayNameFor(input.instrument)} ${direction} trend is developing but confluence is incomplete.` : status === "no_setup" ? `${displayNameFor(input.instrument)} has no aligned 15m trend.` : `${displayNameFor(input.instrument)} is blocked by required filters.`;
  return finalize(input, { direction, entry, stop, target, riskReward, position }, conditions, status, summary);
}

function finalize(input: StrategyEvaluationInput, trade: { direction: "long" | "short"; entry: number | null; stop: number | null; target: number | null; riskReward: number | null; position: ReturnType<typeof calculatePositionSize> } | null, conditions: StrategyCondition[], status: StrategySetup["status"], summary: string): StrategySetup {
  return {
    status,
    instrument: input.instrument,
    pair: displayNameFor(input.instrument),
    direction: trade?.direction ?? null,
    timeframe: "15m",
    entry: trade?.entry ?? null,
    stop: trade?.stop ?? null,
    target: trade?.target ?? null,
    riskReward: trade?.riskReward ?? null,
    positionSize: trade?.position ? {
      riskAmount: trade.position.riskAmount,
      stopDistancePips: trade.position.stopDistancePips,
      calculatedStandardLots: trade.position.calculatedStandardLots,
      calculatedUnits: trade.position.calculatedUnits,
      calculatedEstimatedRisk: trade.position.calculatedEstimatedRisk,
      units: trade.position.units,
      standardLots: trade.position.standardLots,
      estimatedRisk: trade.position.estimatedRisk,
      capStandardLots: trade.position.capStandardLots,
      capped: trade.position.capped,
    } : null,
    summary,
    conditions,
    passedConditions: conditions.filter((item) => item.passed),
    failedConditions: conditions.filter((item) => !item.passed),
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    dataSource: input.dataSource,
  };
}

const rank: Record<StrategySetup["status"], number> = { valid: 4, developing: 3, no_setup: 2, invalid: 1 };

export function rankStrategySetups(setups: StrategySetup[]): StrategyEvaluationBundle {
  const ordered = [...setups].sort((left, right) => rank[right.status] - rank[left.status] || right.passedConditions.length - left.passedConditions.length || left.instrument.localeCompare(right.instrument));
  return { setups: ordered, bestSetup: ordered[0]!, evaluatedAt: new Date().toISOString() };
}
