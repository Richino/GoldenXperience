import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { analyzeTrendPullbackV1, TREND_PULLBACK_V1, type TrendPullbackV1Result } from "@/lib/strategy/trend-pullback-v1";
import type { Candle, MajorInstrument } from "@/types/forex";

/**
 * Automate: watch the TrendPullbackV1 level and confirm the pullback on the
 * last completed M15 candle, the two checks that were done by eye:
 * - REJECTION: the candle reaches the zone and closes back out of it in the
 *   trend direction as a pin bar (long wick into the zone) or an engulfing bar.
 * - SWEEP: the candle wicks through the far side of the zone and closes back
 *   inside it (a liquidity sweep of the stops parked past the level).
 * The level comes from the candles BEFORE the candle being judged, so the
 * candle that confirms cannot move the level it is judged against.
 * Nothing here is backtested; it removes the manual check, not the risk.
 */
export const PULLBACK_WATCH = {
  /** A sweep must poke at least this far past the zone. */
  minSweepPips: 0.5,
  /** Pin bar: the wick into the zone is at least this share of the candle. */
  pinWickShare: 0.5,
  /** Sweep: the close sits in this top (long) / bottom (short) share of the candle. */
  sweepCloseShare: 0.5,
  /** Stop goes this far past the wick, on top of the spread. */
  stopBufferPips: 1,
  /** Blocked when the spread is more than this share of the stop. */
  maxSpreadShareOfRisk: TREND_PULLBACK_V1.maxSpreadShareOfRisk,
  /** A confirmation is only actionable this long after its candle closes. */
  signalFreshMinutes: 20,
} as const;

export type PullbackWatchState = "NO_PLAN" | "WAITING" | "AT_LEVEL" | "CONFIRMED" | "INVALIDATED";
export type PullbackConfirmation = "REJECTION" | "SWEEP";

export type PullbackWatch = {
  state: PullbackWatchState;
  confirmation: PullbackConfirmation | null;
  direction: "long" | "short" | null;
  /** Close time of the judged candle (open time + 15 minutes). */
  candleCloseTime: string | null;
  candle: Pick<Candle, "time" | "open" | "high" | "low" | "close"> | null;
  level: number | null;
  zoneNear: number | null;
  zoneFar: number | null;
  counterTrend: boolean;
  rewardRisk: number | null;
  reason: string;
  plan: TrendPullbackV1Result | null;
};

export type PullbackTrade = {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  riskPips: number;
  rewardRisk: number;
  spreadPips: number;
  spreadShare: number;
  blocked: string | null;
};

const M15_MS = 15 * 60_000;

/** Judge the last completed M15 candle against the pullback zone built from the candles before it. */
export function evaluatePullbackWatch(input: {
  instrument: MajorInstrument;
  candles: Candle[];
  h1Candles?: Candle[];
  h4Candles?: Candle[];
}): PullbackWatch {
  const settings = PULLBACK_WATCH;
  const pip = pipSizeFor(input.instrument);
  const completed = input.candles.filter((candle) => candle.complete !== false);
  const candle = completed.at(-1);
  const prior = completed.at(-2);
  const empty: PullbackWatch = {
    state: "NO_PLAN", confirmation: null, direction: null, candleCloseTime: null, candle: null,
    level: null, zoneNear: null, zoneFar: null, counterTrend: false, rewardRisk: null, reason: "", plan: null,
  };
  if (!candle || !prior) return { ...empty, reason: "Not enough completed M15 candles." };

  // The plan as it stood before this candle; its own last close is the price.
  const plan = analyzeTrendPullbackV1({ instrument: input.instrument, candles: completed.slice(0, -1), h1Candles: input.h1Candles, h4Candles: input.h4Candles });
  if (!plan.action || plan.entry === null || plan.riskReward === null) {
    return { ...empty, plan, reason: plan.reasons[0] ?? "No pullback plan." };
  }
  const long = plan.action === "LONG";
  const sign = long ? 1 : -1;
  const tolerance = TREND_PULLBACK_V1.entryBufferPips * pip;
  const level = plan.entry;
  const zoneNear = level + sign * tolerance;
  const zoneFar = (plan.debug.levelExtreme ?? level) - sign * tolerance;
  const round = (value: number) => Number(value.toFixed(precisionFor(input.instrument)));
  const base: PullbackWatch = {
    ...empty, direction: long ? "long" : "short", plan,
    candleCloseTime: new Date(Date.parse(candle.time) + M15_MS).toISOString(),
    candle: { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    level, zoneNear: round(zoneNear), zoneFar: round(zoneFar), counterTrend: plan.counterTrend, rewardRisk: plan.riskReward,
  };

  // Measure everything as "into the zone" so one set of rules covers both sides.
  const into = (price: number) => sign * (zoneNear - price); // > 0 once price is inside/past the near edge
  const depth = sign * (zoneNear - zoneFar); // zone thickness, always > 0
  const range = candle.high - candle.low;
  const reach = into(long ? candle.low : candle.high);
  const closeInto = into(candle.close);
  const side = long ? "support" : "resistance";

  if (closeInto > depth + tolerance) {
    return { ...base, state: "INVALIDATED", reason: `M15 closed through ${side} at ${level}; waiting for the next level.` };
  }
  if (reach < 0 || !(range > 0)) {
    return { ...base, state: "WAITING", reason: `Waiting for price to reach ${side} at ${level} (${(Math.abs(reach) / pip).toFixed(1)} pips away).` };
  }

  const bodyEdge = long ? Math.min(candle.open, candle.close) : Math.max(candle.open, candle.close);
  const wickShare = Math.abs(bodyEdge - (long ? candle.low : candle.high)) / range;
  const closeShare = (long ? candle.close - candle.low : candle.high - candle.close) / range;
  const withTrend = long ? candle.close > candle.open : candle.close < candle.open;
  const engulfing = withTrend
    && (long ? prior.close < prior.open : prior.close > prior.open)
    && (long ? candle.close >= prior.open && candle.open <= prior.close : candle.close <= prior.open && candle.open >= prior.close);
  const swept = reach > depth + settings.minSweepPips * pip;

  if (swept && closeInto < depth && closeShare >= settings.sweepCloseShare) {
    return { ...base, state: "CONFIRMED", confirmation: "SWEEP", reason: `Swept ${long ? "below" : "above"} ${side} at ${level} and closed back inside.` };
  }
  if (!swept && closeInto < 0 && (wickShare >= settings.pinWickShare || engulfing)) {
    return { ...base, state: "CONFIRMED", confirmation: "REJECTION", reason: `${engulfing ? "Engulfing" : "Pin bar"} rejection at ${side} ${level}.` };
  }
  return { ...base, state: "AT_LEVEL", reason: `Price is at ${side} ${level}; waiting for a rejection or sweep candle to close.` };
}

/** The trade a confirmation gives right now: market entry, stop past the wick and zone plus spread. */
export function pullbackTradeFromWatch(watch: PullbackWatch, instrument: MajorInstrument, quote: { bid: number; ask: number }): PullbackTrade | null {
  if (watch.state !== "CONFIRMED" || !watch.direction || !watch.candle || watch.zoneFar === null || watch.rewardRisk === null) return null;
  const settings = PULLBACK_WATCH;
  const pip = pipSizeFor(instrument);
  const round = (value: number) => Number(value.toFixed(precisionFor(instrument)));
  const long = watch.direction === "long";
  const sign = long ? 1 : -1;
  const spread = quote.ask - quote.bid;
  const entry = long ? quote.ask : quote.bid;
  const wick = long ? Math.min(watch.candle.low, watch.zoneFar) : Math.max(watch.candle.high, watch.zoneFar);
  let stop = wick - sign * (spread + settings.stopBufferPips * pip);
  if (sign * (entry - stop) < TREND_PULLBACK_V1.minStopPips * pip) stop = entry - sign * TREND_PULLBACK_V1.minStopPips * pip;
  const risk = sign * (entry - stop);
  if (!(risk > 0)) return null;
  const riskPips = risk / pip;
  const spreadPips = spread / pip;
  const spreadShare = spreadPips / riskPips;
  return {
    direction: watch.direction,
    entry: round(entry),
    stop: round(stop),
    target: round(entry + sign * watch.rewardRisk * risk),
    riskPips: Number(riskPips.toFixed(1)),
    rewardRisk: watch.rewardRisk,
    spreadPips: Number(spreadPips.toFixed(1)),
    spreadShare: Number(spreadShare.toFixed(3)),
    blocked: spreadShare > settings.maxSpreadShareOfRisk
      ? `Spread ${spreadPips.toFixed(1)} pips is ${Math.round(spreadShare * 100)}% of the ${riskPips.toFixed(1)}-pip stop (limit ${Math.round(settings.maxSpreadShareOfRisk * 100)}%).`
      : null,
  };
}

/** Whether a confirmation is still fresh enough to act on. */
export function pullbackSignalFresh(watch: PullbackWatch, now = new Date()) {
  return watch.candleCloseTime !== null && now.getTime() - Date.parse(watch.candleCloseTime) <= PULLBACK_WATCH.signalFreshMinutes * 60_000;
}
