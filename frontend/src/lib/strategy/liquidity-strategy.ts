import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues, calculateEmaValues, calculateRsiValues } from "@/lib/strategy/indicators";
import { calculatePositionSize, DEFAULT_RISK_POLICY, spreadWithinLimit } from "@/lib/risk/engine";
import { dayTradingSession } from "@/lib/strategy/strategy-engine";
import { mapLiquidityLevels, swingPoints } from "@/lib/strategy/liquidity-levels";
import {
  findSweep, hasDisplacement, hasRejection, hasRetest, hasStructureBreak, nearestLevel, RULES,
} from "@/lib/strategy/liquidity-confirmation";
import type { MacroBias } from "@/lib/macro/rates";
import type {
  StrategyCondition, StrategyEvaluationInput, StrategyResearchFeatures, StrategySetup,
} from "@/lib/strategy/types";

/**
 * Liquidity-sweep strategy with a macro tilt.
 *
 * Reads a setup as: price took a level where orders were resting, could not
 * hold beyond it, and turned. The trade is the turn, and the stop sits behind
 * the extreme of the sweep — the price that would prove the read wrong.
 *
 * Two mechanisms decide whether a setup trades. Hard requirements are
 * conditions under which no trade is acceptable regardless of quality: closed
 * session, blown spread, news window, daily cap. Everything else is scored, so
 * a strong setup can miss a factor and still trade. The threshold is the single
 * number that decides how often this trades at all, which makes it the one to
 * revisit after a batch.
 */
/**
 * The one version used by the live snapshot, paper cycle, and active research.
 * Historical strategy rows remain immutable records; changing this begins a
 * new, separately attributable batch rather than rewriting prior evidence.
 */
export const LIQUIDITY_STRATEGY_VERSION = "trend-pullback-liquidity-v1";

/**
 * The scorecard, out of eight.
 *
 * The sweep is deliberately not scored. Scoring only runs once one has been
 * found, so awarding points for it would add the same two to every setup and
 * make every threshold read higher than it really is.
 *
 * `minimumToTrade` is calibrated rather than chosen. Replayed over stored
 * candles it puts roughly 3.6 setups a day in front of the collector across ten
 * pairs. With the daily cap lifted every one of those is taken, so this
 * threshold is now the only thing setting the sample rate. It is the first
 * number to revisit once a batch is in.
 */
export const SCORE = {
  atLevel: 2,
  rejectionOrDisplacement: 2,
  structureBreak: 2,
  macroAgrees: 1,
  overlapSession: 1,
  minimumToTrade: 7,
} as const;

export const RISK = {
  /** Beyond the sweep's extreme, so noise around the level does not stop it out. */
  stopBeyondExtremeAtr: 0.5,
  /** A stop tighter than this is inside the market's own noise. */
  minimumStopAtr: 1.0,
  targetR: 2.0,
  /**
   * Unlimited. The batch is a sample before it is an account, and a daily cap
   * does not take the best three setups — it takes the first three, which are
   * whichever fired earliest in the session. That is a time-of-day bias baked
   * into the very data the threshold is calibrated against. Set a number here
   * to restore the cap once the sample is large enough to spend.
   */
  maxTradesPerDay: null as number | null,
} as const;

const MAX_SPREAD_PIPS: Record<string, number> = {
  EUR_USD: 1.5, GBP_USD: 2, USD_JPY: 1.5, AUD_USD: 2, NZD_USD: 2,
  USD_CAD: 2, USD_CHF: 2, EUR_GBP: 2, EUR_JPY: 2, GBP_JPY: 2.5,
};

const MINIMUM_CANDLES = 210;

function condition(name: string, passed: boolean, reason: string, currentValue: string, required = false): StrategyCondition {
  return { name, passed, required, reason, currentValue };
}

const completed = (candles: StrategyEvaluationInput["candles15m"]) => candles.filter((candle) => candle.complete);

function trendOf(candles: StrategyEvaluationInput["candles15m"]) {
  const closes = candles.map((candle) => candle.close);
  const ema21 = calculateEmaValues(closes, 21).at(-1) ?? null;
  const ema50 = calculateEmaValues(closes, 50).at(-1) ?? null;
  const ema200 = calculateEmaValues(closes, 200).at(-1) ?? null;
  if (ema21 === null || ema50 === null || ema200 === null) return { trend: "mixed" as const, ema21, ema50, ema200 };
  if (ema21 > ema50 && ema50 > ema200) return { trend: "bullish" as const, ema21, ema50, ema200 };
  if (ema21 < ema50 && ema50 < ema200) return { trend: "bearish" as const, ema21, ema50, ema200 };
  return { trend: "mixed" as const, ema21, ema50, ema200 };
}

export interface LiquidityEvaluationInput extends StrategyEvaluationInput {
  /** Resolved by the caller: this module does no I/O. */
  macroBias?: MacroBias;
  macroDetail?: string;
}

export function evaluateLiquiditySetup(input: LiquidityEvaluationInput): StrategySetup {
  const candles15m = completed(input.candles15m);
  const candles1h = completed(input.candles1h);
  const candles4h = completed(input.candles4h);
  const conditions: StrategyCondition[] = [];
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();

  const hasData = input.dataSource === "oanda"
    && candles15m.length >= MINIMUM_CANDLES && candles1h.length >= MINIMUM_CANDLES && candles4h.length >= MINIMUM_CANDLES;
  conditions.push(condition("Market data", hasData,
    hasData ? "Completed OANDA candles are available on all timeframes." : "Live OANDA candle history is unavailable or incomplete.",
    `${candles15m.length}/${candles1h.length}/${candles4h.length} candles`, true));
  if (!hasData) return finalize(input, evaluatedAt, null, conditions, "invalid", "Live candle history is required before a decision.");

  const atr = calculateAtrValues(candles15m, 14).at(-1) ?? 0;
  const rsi = calculateRsiValues(candles15m.map((candle) => candle.close), 14).at(-1) ?? null;
  const pip = pipSizeFor(input.instrument);
  const primary = trendOf(candles15m);
  const structure = swingPoints(candles15m.slice(-120), RULES.swingReach);

  const features: StrategyResearchFeatures = {
    trend15m: primary.trend,
    trend1h: trendOf(candles1h).trend,
    trend4h: trendOf(candles4h).trend,
    ema21: primary.ema21, ema50: primary.ema50, ema200: primary.ema200,
    rsi14: rsi, atr14: atr || null, atrPips: atr ? atr / pip : null,
    structureHighs: structure.highs.length, structureLows: structure.lows.length,
    liquidity: null,
  };

  // ---- Hard requirements: no trade while any of these fail ----
  const session = dayTradingSession(new Date(evaluatedAt));
  conditions.push(condition("Session", session.open && input.marketOpen,
    session.open && input.marketOpen ? `${session.label} is trading.` : "Entries are limited to the London and New York sessions and close at 16:45 ET.",
    session.label, true));

  const maxSpread = MAX_SPREAD_PIPS[input.instrument] ?? 1.5;
  const spreadOk = spreadWithinLimit(input.spreadPips, maxSpread);
  conditions.push(condition("Spread", spreadOk,
    spreadOk ? "Spread is inside the pair limit." : input.spreadPips === null ? "No live spread available." : "Spread too wide.",
    input.spreadPips === null ? "unavailable" : `${input.spreadPips.toFixed(1)} / ${maxSpread.toFixed(1)} pips`, true));

  const newsRequired = input.newsRequired ?? true;
  const newsClear = !input.calendarConnected || input.highImpactNewsWithinMinutes === null || input.highImpactNewsWithinMinutes > 30;
  conditions.push(condition("News", newsClear,
    !input.calendarConnected ? "No calendar connected; news is not filtered." : newsClear ? "No high-impact release inside the 30-minute buffer." : "High-impact release inside the buffer.",
    input.highImpactNewsWithinMinutes === null ? "none upcoming" : `${input.highImpactNewsWithinMinutes} minutes`, newsRequired));

  // ---- The setup ----
  const levels = mapLiquidityLevels(candles15m, candles1h, candles4h);
  const sweep = findSweep(candles15m, levels, atr);
  conditions.push(condition("Liquidity sweep", sweep !== null,
    sweep ? `${sweep.level.label} was taken and reclaimed ${sweep.barsAgo} bars ago.` : "No level has been taken and given back.",
    sweep ? sweep.level.label : `${levels.length} levels mapped`));

  if (!sweep) return finalize(input, evaluatedAt, null, conditions, "no_setup", `${displayNameFor(input.instrument)} has no liquidity sweep.`, features);

  const direction = sweep.direction;
  const last = candles15m.at(-1)!;
  const location = nearestLevel(last.close, levels, atr);
  const rejection = hasRejection(last, direction);
  const displacement = hasDisplacement(candles15m, direction, atr);
  const structureBreak = hasStructureBreak(candles15m, direction);
  const retest = hasRetest(candles15m, sweep.level.price, direction, atr);
  const macroBias = input.macroBias ?? "neutral";
  const macroAgrees = macroBias === direction;
  const overlap = session.label === "London/New York overlap";

  conditions.push(condition("Location", location !== null,
    location ? `Price is at ${location.level.label}.` : "Price is not at a mapped level.",
    location ? location.level.label : "none"));
  conditions.push(condition("Rejection or displacement", rejection || displacement,
    rejection ? "Rejection candle off the level." : displacement ? "Displacement away from the level." : "No rejection or displacement.",
    `${rejection ? "rejection" : ""}${rejection && displacement ? " + " : ""}${displacement ? "displacement" : ""}` || "neither"));
  conditions.push(condition("Structure break", structureBreak,
    structureBreak ? "Closed beyond the last swing in the trade's direction." : "Structure has not broken in this direction.",
    structureBreak ? "broken" : "intact"));
  conditions.push(condition("Macro", macroAgrees,
    input.macroDetail ?? (macroAgrees ? "Rate differential favours this direction." : "Rate differential does not favour this direction."),
    macroBias));
  conditions.push(condition("Retest", retest, retest ? "Price retested the level and held." : "No retest yet.", retest ? "retested" : "none"));

  const score =
    (location ? SCORE.atLevel : 0)
    + (rejection || displacement ? SCORE.rejectionOrDisplacement : 0)
    + (structureBreak ? SCORE.structureBreak : 0)
    + (macroAgrees ? SCORE.macroAgrees : 0)
    + (overlap ? SCORE.overlapSession : 0);

  // Everything the scorecard just read, kept on the setup so it reaches the
  // trade row. Recorded whether or not this one trades, so the batch can be
  // compared against the setups that were passed over.
  features.liquidity = {
    sweptLevelKind: sweep.level.kind,
    sweptLevelSide: sweep.level.side,
    sweptLevelPrice: sweep.level.price,
    sweepDepthAtr: atr > 0 ? Math.abs(sweep.extreme - sweep.level.price) / atr : null,
    sweepBarsAgo: sweep.barsAgo,
    atLevelKind: location?.level.kind ?? null,
    rejection,
    displacement,
    structureBreak,
    retest,
    macroBias,
    macroAgrees,
    overlapSession: overlap,
    session: session.label,
    score,
    scoreOutOf: SCORE.atLevel + SCORE.rejectionOrDisplacement + SCORE.structureBreak + SCORE.macroAgrees + SCORE.overlapSession,
  };

  // ---- Levels and size ----
  const entry = direction === "long" ? input.ask : input.bid;
  const stopBehind = direction === "long"
    ? sweep.extreme - atr * RISK.stopBeyondExtremeAtr
    : sweep.extreme + atr * RISK.stopBeyondExtremeAtr;
  const stop = entry === null ? null
    : direction === "long"
      ? Math.min(stopBehind, entry - atr * RISK.minimumStopAtr)
      : Math.max(stopBehind, entry + atr * RISK.minimumStopAtr);
  const risk = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  const target = entry === null || risk === null ? null
    : direction === "long" ? entry + risk * RISK.targetR : entry - risk * RISK.targetR;
  const riskReward = risk ? RISK.targetR : null;
  const position = entry !== null && stop !== null
    ? calculatePositionSize({ instrument: input.instrument, accountBalance: input.accountBalance, riskPercent: DEFAULT_RISK_POLICY.riskPercent, entry, stop, applyPaperCap: false })
    : null;

  const scoreReached = score >= SCORE.minimumToTrade;
  conditions.push(condition("Setup score", scoreReached,
    scoreReached ? `Scored ${score}, at or above the ${SCORE.minimumToTrade} required.` : `Scored ${score}, below the ${SCORE.minimumToTrade} required.`,
    `${score}/${features.liquidity.scoreOutOf}`, true));

  const hardFailed = conditions.some((item) => item.required && !item.passed);
  const status: StrategySetup["status"] = entry === null || stop === null || target === null ? "invalid"
    : hardFailed ? (scoreReached ? "invalid" : "no_setup")
      : "valid";

  const summary = status === "valid"
    ? `${displayNameFor(input.instrument)} ${direction} off ${sweep.level.label}, scored ${score}/${features.liquidity.scoreOutOf}.`
    : scoreReached
      ? `${displayNameFor(input.instrument)} ${direction} scored ${score}/${features.liquidity.scoreOutOf} but a hard requirement failed.`
      : `${displayNameFor(input.instrument)} ${direction} scored ${score}/${features.liquidity.scoreOutOf}, below ${SCORE.minimumToTrade}.`;

  return finalize(input, evaluatedAt, { direction, entry, stop, target, riskReward, position }, conditions, status, summary, features);
}

const EMPTY_FEATURES: StrategyResearchFeatures = {
  trend15m: "mixed", trend1h: null, trend4h: null, ema21: null, ema50: null, ema200: null,
  rsi14: null, atr14: null, atrPips: null, structureHighs: 0, structureLows: 0, liquidity: null,
};

function finalize(
  input: StrategyEvaluationInput,
  evaluatedAt: string,
  trade: { direction: "long" | "short"; entry: number | null; stop: number | null; target: number | null; riskReward: number | null; position: ReturnType<typeof calculatePositionSize> } | null,
  conditions: StrategyCondition[],
  status: StrategySetup["status"],
  summary: string,
  features: StrategyResearchFeatures = EMPTY_FEATURES,
): StrategySetup {
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
    features,
    summary,
    conditions,
    passedConditions: conditions.filter((item) => item.passed),
    failedConditions: conditions.filter((item) => !item.passed),
    evaluatedAt,
    dataSource: input.dataSource,
  };
}
