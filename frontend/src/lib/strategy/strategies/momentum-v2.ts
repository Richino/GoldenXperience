import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateEmaValues, calculateRsiValues } from "@/lib/strategy/indicators";
import {
  buildTradePlan, completedCandles, condition, evaluateHardGates, finalizeCandidate,
} from "@/lib/strategy/strategy-common";
import type { Strategy, StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, MomentumFeatures, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * Strategy C — Momentum V2. REJECTED. NOT REGISTERED. DO NOT ENABLE.
 *
 * Kept only so the negative result is reproducible rather than rediscovered.
 * Run scripts/_momentum-v2-replay.ts to regenerate the numbers below.
 *
 * Walk-forward replay, EUR_USD + GBP_USD + USD_JPY, one open position per
 * instrument, spread paid, no look-ahead:
 *
 *                    development (2022-08..2025-08)   sealed holdout
 *   V1 (registered)   2293 trades   -0.068 R/trade     724 trades  -0.086
 *   V2 (this file)    2095 trades   -0.179 R/trade     686 trades  -0.204
 *
 * V2 is worse than the strategy it was meant to replace, on every pair, in
 * both periods. The hypothesis below was wrong and is recorded as such.
 *
 * Where it went wrong is the interesting part, and is worth knowing before
 * anyone tries this shape again. The pullback entry DID do what it was designed
 * to do — average favourable excursion rose from 0.73R to 0.88R, so the entry
 * location genuinely improved. But the stop that comes with it sits behind the
 * pullback rather than the whole impulse, which is much closer to price, and
 * adverse excursion rose further still, 0.74R to 1.04R. Better entries, hit
 * more often, netting worse. A tighter stop was not rescued by a better entry;
 * it was punished by one.
 *
 * The deeper reading: V1 loses about 0.07R per trade over 3000+ trades, which
 * is roughly what paying the spread on a coin flip costs. Momentum in this
 * family does not have an edge to reposition — it has no edge at all, and no
 * entry rule tested so far changes that.
 *
 * The original V2 rationale follows, unedited, as the record of what was tried.
 *
 *
 * V1 is kept beside this, untouched. This is deliberately not a parameter
 * change: V1's entry rule is the thing that failed, so re-tuning it could not
 * have helped.
 *
 * What V1 did, and why it lost. It required a 1.5 ATR run over five bars, AND
 * the latest candle to be a strong in-direction body, AND two consecutive
 * in-direction closes, AND the move to still be accelerating. Every one of
 * those is most true at the final, most extended bar of a push, so the rule
 * bought precisely the local extreme. Its stop then went behind the whole
 * six-bar swing — about 3.8 ATR, twice the other strategies' — putting its
 * target some 7.6 ATR away while these pairs travel about 2.3 ATR. One trade in
 * twenty-one ever reached it.
 *
 * The measurement that rules out a geometry fix: average peak gain 0.56R
 * against average peak pain 0.93R. The trades went against the entry further
 * than they ever went for it, so no stop or target arrangement wins. Sweeping
 * every stop cap and target multiple over the recorded paths confirmed it: all
 * fourteen combinations lost, and tightening the stop lost fastest, because it
 * only converted trades limping to breakeven into full losses.
 *
 * So V2 changes where the entry happens, not how the trade is sized:
 *
 *   1. Direction comes from the H1 trend, which V1 never consulted at all. A
 *      15-minute run with no higher-timeframe context is mostly noise, and the
 *      data agreed — V1's weakest prior moves lost the most.
 *   2. It waits for the impulse to END, then for a retracement of a quarter to
 *      two thirds of it. Shallower is not a pullback; deeper means the impulse
 *      failed rather than rested.
 *   3. It enters on a completed candle turning back in the impulse direction,
 *      so a falling knife is not caught mid-fall.
 *   4. The stop sits behind the pullback extreme, not behind the entire
 *      impulse. The tighter stop is a consequence of the better entry location,
 *      never a cap imposed on the old one — capping V1's stop was measured and
 *      made it worse.
 *
 * This is a hypothesis with a mechanism behind it, not a fitted result. It
 * earns a place in the rotation only if it survives a walk-forward replay on
 * data it was never tuned against.
 */
export interface MomentumV2Config {
  /** Bars searched for the impulse and the pullback that follows it. */
  swingLookbackBars: number;
  /** Minimum impulse size, in ATR, to be worth trading at all. */
  minImpulseAtr: number;
  /** The impulse must have ended at least this many bars ago (never at the extreme). */
  minPullbackBars: number;
  /** ...and no longer ago than this, or the move has gone stale. */
  maxPullbackBars: number;
  /** Retracement of the impulse, as a fraction, that counts as a pullback. */
  minRetrace: number;
  maxRetrace: number;
  h1EmaFastPeriod: number;
  h1EmaSlowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  stopBufferAtr: number;
  targetR: number;
  minStopAtr: number;
}

export const MOMENTUM_V2_VERSION = "momentum-v2";
export const MOMENTUM_V2_CONFIG_VERSION = "momentum-cfg-v2";

export const DEFAULT_MOMENTUM_V2_CONFIG: MomentumV2Config = {
  swingLookbackBars: 12,
  minImpulseAtr: 1.5,
  minPullbackBars: 1,
  maxPullbackBars: 5,
  minRetrace: 0.25,
  maxRetrace: 0.618,
  h1EmaFastPeriod: 21,
  h1EmaSlowPeriod: 50,
  rsiPeriod: 14,
  rsiOverbought: 80,
  rsiOversold: 20,
  stopBufferAtr: 0.35,
  targetR: 2.0,
  minStopAtr: 0.8,
};

/** The H1 trend, which sets the only direction V2 will trade. */
function h1Direction(candles1h: Candle[], config: MomentumV2Config): "long" | "short" | null {
  const closes = candles1h.map((candle) => candle.close);
  const fast = calculateEmaValues(closes, config.h1EmaFastPeriod).at(-1) ?? null;
  const slow = calculateEmaValues(closes, config.h1EmaSlowPeriod).at(-1) ?? null;
  if (fast === null || slow === null || fast === slow) return null;
  return fast > slow ? "long" : "short";
}

export function evaluateMomentumV2(input: StrategyEvaluationInput, regime: MarketRegime, config: MomentumV2Config): StrategyCandidate {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const candles15m = completedCandles(input.candles15m);
  const candles1h = completedCandles(input.candles1h);
  const candles4h = completedCandles(input.candles4h);

  const gate = evaluateHardGates(input, evaluatedAt, candles15m, candles1h, candles4h);
  const conditions: StrategyCondition[] = [...gate.conditions];
  const finalize = (status: StrategyCandidate["status"], summary: string, reason: string, direction: StrategyCandidate["direction"], plan: ReturnType<typeof buildTradePlan> | null, features?: MomentumFeatures) =>
    finalizeCandidate({
      family: "momentum", version: MOMENTUM_V2_VERSION, configVersion: MOMENTUM_V2_CONFIG_VERSION, input, evaluatedAt, regime,
      direction, plan, conditions, status, summary, qualifyReason: reason,
      features: { trend15m: "mixed", trend1h: null, trend4h: null, ema21: regime.emaFast, ema50: regime.emaMid, ema200: regime.emaSlow, rsi14: features?.rsi14 ?? null, atr14: regime.atr, atrPips: regime.atrPips, structureHighs: 0, structureLows: 0, regime, momentum: features ?? null },
    });

  const gateFail = conditions.find((item) => item.required && !item.passed);
  if (gateFail) return finalize("no_setup", displayNameFor(input.instrument) + " momentum blocked by " + gateFail.name.toLowerCase() + ".", gateFail.reason, null, null);

  const atr = regime.atr ?? 0;
  if (atr <= 0 || candles15m.length < config.swingLookbackBars + 1) {
    return finalize("invalid", displayNameFor(input.instrument) + " momentum inputs unavailable.", "ATR or candle history is insufficient.", null, null);
  }

  const closes = candles15m.map((candle) => candle.close);
  const rsi = calculateRsiValues(closes, config.rsiPeriod).at(-1) ?? null;

  // 1. Direction is the H1 trend. V1 read nothing above M15 and traded whatever
  //    the last five bars happened to do; a run against the hourly trend is the
  //    retracement of a larger move, not a momentum trade.
  const direction = h1Direction(candles1h, config);
  conditions.push(condition("H1 trend", direction !== null,
    direction !== null ? "The hourly trend is " + direction + "." : "The hourly trend is flat or unavailable.",
    direction ?? "none", true));
  if (!direction) return finalize("no_setup", displayNameFor(input.instrument) + " has no hourly trend.", "The hourly trend is flat or unavailable.", null, null);

  // 2. The impulse: the furthest extreme reached inside the swing window,
  //    measured from the window's opening close so it is a real displacement.
  const window = candles15m.slice(-config.swingLookbackBars);
  const startClose = window[0]!.close;
  let extremeIndex = 0;
  for (const [index, candle] of window.entries()) {
    const better = direction === "long"
      ? candle.high > window[extremeIndex]!.high
      : candle.low < window[extremeIndex]!.low;
    if (better) extremeIndex = index;
  }
  const extreme = direction === "long" ? window[extremeIndex]!.high : window[extremeIndex]!.low;
  const impulse = direction === "long" ? extreme - startClose : startClose - extreme;
  const impulseAtr = impulse / atr;
  const strongEnough = impulseAtr >= config.minImpulseAtr;
  conditions.push(condition("Impulse", strongEnough,
    strongEnough ? "A " + impulseAtr.toFixed(2) + " ATR impulse ran with the hourly trend." : "No impulse worth trading.",
    impulseAtr.toFixed(2) + " ATR", true));
  if (!strongEnough) return finalize("no_setup", displayNameFor(input.instrument) + " has no impulse.", "No impulse worth trading.", direction, null);

  // 3. The impulse must be over. Entering on the extreme bar is exactly what V1
  //    did, and is what put its adverse excursion above its favourable one.
  const pullbackBars = window.length - 1 - extremeIndex;
  const endedCleanly = pullbackBars >= config.minPullbackBars && pullbackBars <= config.maxPullbackBars;
  conditions.push(condition("Impulse ended", endedCleanly,
    endedCleanly ? "The impulse topped out " + pullbackBars + " bars ago."
      : pullbackBars < config.minPullbackBars ? "Price is still at the extreme; this is the bar V1 would have bought."
        : "The impulse is stale.",
    pullbackBars + " bars", true));

  // 4. A pullback of a quarter to two thirds. Shallower is not a pullback at
  //    all; deeper and the impulse has been given back rather than rested.
  const lastClose = closes.at(-1)!;
  const retrace = impulse > 0 ? (direction === "long" ? extreme - lastClose : lastClose - extreme) / impulse : 0;
  const retraceOk = retrace >= config.minRetrace && retrace <= config.maxRetrace;
  conditions.push(condition("Pullback depth", retraceOk,
    retraceOk ? "Price retraced " + (retrace * 100).toFixed(0) + "% of the impulse."
      : retrace < config.minRetrace ? "Price has barely pulled back." : "The pullback gave back too much of the impulse.",
    (retrace * 100).toFixed(0) + "%", true));

  // 5. A completed candle turning back the trend's way, so the pullback is
  //    resuming rather than still falling.
  const last = candles15m.at(-1)!;
  const resuming = direction === "long" ? last.close > last.open : last.close < last.open;
  conditions.push(condition("Resumption", resuming,
    resuming ? "A completed candle turned back in the trend direction." : "The pullback has not turned yet.",
    resuming ? "confirmed" : "none", true));

  const rsiExtreme = rsi !== null && (direction === "long" ? rsi >= config.rsiOverbought : rsi <= config.rsiOversold);
  conditions.push(condition("Not exhausted", !rsiExtreme,
    !rsiExtreme ? "RSI is not at an extreme." : "RSI is at an extreme.",
    rsi === null ? "n/a" : rsi.toFixed(0), true));

  // 6. The stop goes behind the pullback, not behind the whole impulse. This is
  //    the level the trade is actually wrong below, and it is what brings the
  //    target back inside the distance these pairs really travel.
  const pullbackWindow = window.slice(extremeIndex);
  const pullbackExtreme = direction === "long"
    ? Math.min(...pullbackWindow.map((candle) => candle.low))
    : Math.max(...pullbackWindow.map((candle) => candle.high));
  const rawStop = direction === "long" ? pullbackExtreme - atr * config.stopBufferAtr : pullbackExtreme + atr * config.stopBufferAtr;
  const plan = buildTradePlan(input, direction, rawStop, atr, { targetR: config.targetR, minStopAtr: config.minStopAtr });

  const features: MomentumFeatures = {
    momentumAtr: impulseAtr, returnPct: null, accelerationAtr: null,
    bodyRatio: null, consecutiveBars: 0, extensionAtr: impulseAtr, rsi14: rsi,
  };

  const hardFailed = conditions.some((item) => item.required && !item.passed);
  const planValid = plan.entry !== null && plan.stop !== null && plan.target !== null;
  const status = !planValid ? "invalid" : hardFailed ? "no_setup" : "valid";
  const summary = status === "valid"
    ? displayNameFor(input.instrument) + " " + direction + " momentum pullback, " + impulseAtr.toFixed(1) + " ATR impulse retraced " + (retrace * 100).toFixed(0) + "%."
    : displayNameFor(input.instrument) + " " + direction + " momentum pullback incomplete.";
  const reason = status === "valid" ? "Pullback into an H1-aligned impulse, resuming." : conditions.find((item) => item.required && !item.passed)?.reason ?? "Setup incomplete.";
  return finalize(status, summary, reason, direction, plan, features);
}

/** REJECTED — see the file header. Deliberately not exported into the registry. */
const momentumV2StrategyRejected: Strategy<MomentumV2Config> = {
  family: "momentum",
  version: MOMENTUM_V2_VERSION,
  defaultConfigVersion: MOMENTUM_V2_CONFIG_VERSION,
  defaultConfig: DEFAULT_MOMENTUM_V2_CONFIG,
  evaluate: evaluateMomentumV2,
};
void momentumV2StrategyRejected;
