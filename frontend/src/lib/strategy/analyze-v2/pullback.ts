import type { ModeConfig } from "@/lib/strategy/analyze-v2/config";
import type { TrendRead } from "@/lib/strategy/analyze-v2/structure";
import { zonesOnSide, type SrZone } from "@/lib/strategy/analyze-v2/zones";
import type { Candle } from "@/types/forex";

/**
 * Trend-pullback state, read from closed primary candles only.
 *
 *   NOT_APPLICABLE  the primary timeframe is not trending
 *   NO_PULLBACK     price is still at or beyond the impulse extreme
 *   DEVELOPING      retracing, not yet at a meaningful zone
 *   AT_ZONE         the pullback has reached a zone; no trigger yet
 *   TRIGGERED       a closed candle confirmed the turn (see below)
 *   EXPIRED         triggered, but price has already moved on
 *   INVALIDATED     a close went through the trend's structure level
 *
 * Trigger (long; a short mirrors it): after the pullback reached the zone, a
 * completed candle closes above the high of the candle that made the
 * pullback's lowest low. A new lower low resets it, since the trigger must
 * come after the lowest candle (an equal low does not reset it). This is a rule for consistency, not a proven
 * predictor. Retracement depth is reported as context only.
 */

export type PullbackState = "NOT_APPLICABLE" | "NO_PULLBACK" | "DEVELOPING" | "AT_ZONE" | "TRIGGERED" | "EXPIRED" | "INVALIDATED";

export interface PullbackRead {
  state: PullbackState;
  direction: "LONG" | "SHORT" | null;
  /** The impulse extreme the pullback started from. */
  start: { price: number; time: string } | null;
  /** The deepest point of the pullback so far. */
  extreme: { price: number; time: string } | null;
  /** Share of the impulse retraced (context, not proof). */
  depth: number | null;
  /** The zone the pullback reached, if any. */
  zone: SrZone | null;
  /** When still developing: the next zone in the pullback's path, or null when none lies before the structure level. */
  nextZone: SrZone | null;
  /** Close beyond this ends the trend. */
  invalidationLevel: number | null;
  trigger: { time: string; close: number; rule: string } | null;
  /** The close that would confirm the turn: beyond the deepest candle's far side. */
  triggerLevel: number | null;
  barsSinceTrigger: number | null;
  notes: string[];
}

const empty = (state: PullbackState, note: string, direction: PullbackRead["direction"] = null): PullbackRead => ({
  state, direction, start: null, extreme: null, depth: null, zone: null, nextZone: null,
  invalidationLevel: null, trigger: null, triggerLevel: null, barsSinceTrigger: null, notes: [note],
});

export interface PullbackInput {
  trend: TrendRead;
  zones: SrZone[];
  candles: Candle[];
  config: ModeConfig;
  /** Live mid, used only to judge whether a triggered entry has run away. */
  livePrice?: number | null;
}

export function readPullback({ trend, zones, candles, config, livePrice = null }: PullbackInput): PullbackRead {
  if (trend.direction !== "UPTREND" && trend.direction !== "DOWNTREND") {
    return empty("NOT_APPLICABLE", `${trend.timeframe} is ${trend.direction.toLowerCase()}; a trend pullback needs a trend.`);
  }
  const long = trend.direction === "UPTREND";
  const direction = long ? "LONG" : "SHORT";
  const settings = config.pullback;
  const atr = trend.atr;
  const closed = candles.filter((candle) => candle.complete !== false).slice(-config.regime.lookback);
  if (!trend.impulse || trend.structureLevel === null || !(atr > 0) || closed.length < 5) {
    return empty("NOT_APPLICABLE", "No measurable impulse to pull back from.", direction);
  }
  const level = trend.structureLevel;
  const fromTime = trend.impulse.from.time;
  const fromIndex = closed.findIndex((candle) => candle.time === fromTime);
  if (fromIndex < 0) return empty("NOT_APPLICABLE", "The impulse start is outside the candles read.", direction);

  // The impulse extreme: the highest high (long) since the structure low,
  // including candles too recent to be a confirmed pivot yet.
  let startIndex = fromIndex;
  for (let index = fromIndex; index < closed.length; index += 1) {
    const candle = closed[index]!;
    if (long ? candle.high >= closed[startIndex]!.high : candle.low <= closed[startIndex]!.low) startIndex = index;
  }
  const startCandle = closed[startIndex]!;
  const startPrice = long ? startCandle.high : startCandle.low;
  // Depth is measured against the whole impulse, from its origin.
  const legSize = Math.abs(startPrice - trend.impulse.from.price);
  const base: Pick<PullbackRead, "direction" | "start" | "invalidationLevel"> = {
    direction,
    start: { price: startPrice, time: startCandle.time },
    invalidationLevel: level,
  };

  // Structure failure: a close through the structure level.
  const breakDistance = config.regime.breakCloseAtr * atr;
  const structureTime = trend.structureSwing?.time ?? fromTime;
  const brokeAt = closed.filter((candle) => candle.time > structureTime).find((candle) => long ? candle.close < level - breakDistance : candle.close > level + breakDistance);
  if (brokeAt) {
    return { ...empty("INVALIDATED", `Closed ${long ? "below" : "above"} the structure level at ${brokeAt.time}.`), ...base };
  }

  const after = closed.slice(startIndex + 1);
  if (after.length < settings.minBarsSinceExtreme) {
    return { ...empty("NO_PULLBACK", "Price is still at the impulse extreme; no pullback has started."), ...base, depth: 0 };
  }
  let deepIndex = 0;
  for (let index = 1; index < after.length; index += 1) {
    // Strictly beyond: an equal low (a double bottom) does not reset the trigger.
    if (long ? after[index]!.low < after[deepIndex]!.low : after[index]!.high > after[deepIndex]!.high) deepIndex = index;
  }
  const deepCandle = after[deepIndex]!;
  const deepPrice = long ? deepCandle.low : deepCandle.high;
  const depth = legSize > 0 ? Math.abs(startPrice - deepPrice) / legSize : 0;
  const extreme = { price: deepPrice, time: deepCandle.time };
  if (depth < settings.minRetrace) {
    return { ...empty("NO_PULLBACK", `Only ${Math.round(depth * 100)}% of the leg retraced; no meaningful pullback yet.`), ...base, extreme, depth };
  }

  // Zones between the structure level and the impulse extreme, on the pullback side.
  const near = settings.nearZoneAtr * atr;
  const candidates = zonesOnSide(zones, long ? "below" : "above")
    .filter((zone) => long ? zone.high <= startPrice && zone.high >= level - near : zone.low >= startPrice && zone.low <= level + near);
  const reached = candidates
    .filter((zone) => long ? deepPrice <= zone.high + near : deepPrice >= zone.low - near)
    // The first zone in the pullback's path that it reached.
    .sort((a, b) => long ? b.high - a.high : a.low - b.low)[0] ?? null;
  if (!reached) {
    const nextZone = candidates.sort((a, b) => long ? b.high - a.high : a.low - b.low)[0] ?? null;
    return {
      ...base,
      state: "DEVELOPING",
      extreme,
      depth,
      zone: null,
      nextZone,
      trigger: null,
      triggerLevel: null,
      barsSinceTrigger: null,
      notes: [nextZone ? "Pulling back; the next zone has not been reached yet." : "Pulling back, but no meaningful zone lies before the structure level."],
    };
  }

  // Trigger: a close beyond the deepest candle's far side, after that candle.
  const triggerLevel = long ? deepCandle.high : deepCandle.low;
  const triggerOffset = after.slice(deepIndex + 1).findIndex((candle) => long ? candle.close > deepCandle.high : candle.close < deepCandle.low);
  if (triggerOffset < 0) {
    return { ...base, state: "AT_ZONE", extreme, depth, zone: reached, nextZone: null, trigger: null, triggerLevel, barsSinceTrigger: null, notes: ["At the zone; waiting for a closed candle to confirm the turn."] };
  }
  const triggerIndex = deepIndex + 1 + triggerOffset;
  const triggerCandle = after[triggerIndex]!;
  const trigger = {
    time: triggerCandle.time,
    close: triggerCandle.close,
    rule: `Closed ${long ? "above" : "below"} the ${long ? "high" : "low"} of the pullback's ${long ? "lowest" : "highest"} candle (${long ? deepCandle.high : deepCandle.low})`,
  };
  const barsSinceTrigger = after.length - 1 - triggerIndex;
  const lastClose = closed.at(-1)!.close;
  const reference = livePrice ?? lastClose;
  const ranAtr = (long ? reference - trigger.close : trigger.close - reference) / atr;
  const newExtreme = after.slice(triggerIndex + 1).some((candle) => long ? candle.high > startPrice : candle.low < startPrice);
  if (barsSinceTrigger > settings.expireBars || ranAtr > settings.expireAtr || newExtreme) {
    return {
      ...base, state: "EXPIRED", extreme, depth, zone: reached, nextZone: null, trigger, triggerLevel, barsSinceTrigger,
      notes: [newExtreme ? "The move already made a new extreme after the trigger." : ranAtr > settings.expireAtr ? `Price has run ${ranAtr.toFixed(1)} ATR past the trigger; the entry has passed.` : `The trigger is ${barsSinceTrigger} candles old.`],
    };
  }
  return { ...base, state: "TRIGGERED", extreme, depth, zone: reached, nextZone: null, trigger, triggerLevel, barsSinceTrigger, notes: ["A closed candle confirmed the turn at the zone."] };
}
