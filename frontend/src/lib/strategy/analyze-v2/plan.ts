import { precisionFor } from "@/lib/instruments/catalog";
import type { ModeConfig } from "@/lib/strategy/analyze-v2/config";
import { executableEntry, executableRewardRisk, levelsAreOrdered, pipSize, roundPrice, type Side } from "@/lib/strategy/analyze-v2/instrument-math";
import type { PullbackRead } from "@/lib/strategy/analyze-v2/pullback";
import type { TrendRead } from "@/lib/strategy/analyze-v2/structure";
import type { SrZone } from "@/lib/strategy/analyze-v2/zones";

/**
 * The executable trade plan for a confirmed pullback. All numbers are
 * computed here; nothing is taken from a model.
 *
 * Entry: the live executable price (ask for a long, bid for a short): the
 *   trigger has closed, so the entry is now, not at a hoped-for level.
 * Stop: past the thesis's invalidation, by `stopBufferAtr` plus the spread.
 *   STRUCTURE_LEVEL (live, v2.1): the trend's latest higher low / lower high,
 *   or the pullback extreme if it went deeper. PULLBACK_EXTREME (v2.0): the
 *   deepest point of the pullback. Candles are mid prices (candles are mid prices; a long's stop
 *   triggers on the bid, which trades about half a spread below mid). It is
 *   never widened to dodge a hypothetical sweep; a stop further than
 *   `maxStopAtr` fails the plan instead.
 * Target: the first structural obstacle ahead (a structural or higher-
 *   timeframe zone, or the impulse extreme), less a buffer and the spread.
 *   NORMAL aims for `targetPreferencePips` when that fits before the
 *   obstacle and still meets the minimum R; SWING takes the obstacle itself.
 *   The target is never pushed past an obstacle to reach a nicer ratio.
 * R: from executable prices (`executableRewardRisk`), so the spread inside
 *   the entry is counted once. Commission is not modelled (none on OANDA
 *   spread pricing); slippage is not modelled.
 */

export interface Obstacle {
  price: number;
  label: string;
}

export interface TradePlan {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  invalidationLevel: number;
  bufferPips: number;
  stopPips: number;
  targetPips: number;
  /** Reward/risk from executable prices. */
  rewardRisk: number;
  spreadPips: number;
  /** Spread as a share of the risk. */
  spreadShare: number;
  stopBasis: string;
  targetBasis: string;
  obstacle: Obstacle | null;
  /** Minor zones between entry and target. */
  minorObstacles: Obstacle[];
}

export interface PlanOutcome {
  plan: TradePlan | null;
  /** Why no valid stop exists; null when the stop is fine. */
  stopFailure: string | null;
  /** Why no valid target exists; null when the target is fine. */
  targetFailure: string | null;
  /** Why the levels break instrument rules; null when they are fine. */
  rulesFailure: string | null;
  /** Context for the checks, even when the plan failed. */
  stopPips: number | null;
  roomPips: number | null;
  requiredPips: number | null;
  obstacle: Obstacle | null;
  minorObstacles: Obstacle[];
}

export interface PlanInput {
  instrument: string;
  side: Side;
  quote: { bid: number; ask: number; spreadPips: number };
  trend: TrendRead;
  pullback: PullbackRead;
  zones: SrZone[];
  config: ModeConfig;
}

export function buildTradePlan({ instrument, side, quote, trend, pullback, zones, config }: PlanInput): PlanOutcome {
  const settings = config.plan;
  const long = side === "LONG";
  const pip = pipSize(instrument);
  const digits = precisionFor(instrument);
  const atr = trend.atr;
  const spread = quote.ask - quote.bid;
  const empty = (field: "stopFailure" | "targetFailure" | "rulesFailure", reason: string, extra: Partial<PlanOutcome> = {}): PlanOutcome => ({
    plan: null, stopFailure: null, targetFailure: null, rulesFailure: null,
    stopPips: null, roomPips: null, requiredPips: null, obstacle: null, minorObstacles: [],
    ...extra,
    [field]: reason,
  });
  if (!pullback.extreme || !(atr > 0)) return empty("stopFailure", "No pullback low/high to place a structural stop behind.");

  const entry = executableEntry(side, quote);
  const structure = trend.structureLevel;
  const anchoredOnStructure = settings.stopAnchor === "STRUCTURE_LEVEL" && structure !== null;
  const invalidation = anchoredOnStructure
    ? (long ? Math.min(structure, pullback.extreme.price) : Math.max(structure, pullback.extreme.price))
    : pullback.extreme.price;
  const invalidationName = anchoredOnStructure && invalidation === structure
    ? `the ${long ? "higher low" : "lower high"}`
    : `the pullback ${long ? "low" : "high"}`;
  const buffer = settings.stopBufferAtr * atr + spread;
  const stopRaw = long ? invalidation - buffer : invalidation + buffer;
  const risk = long ? entry - stopRaw : stopRaw - entry;
  if (!(risk > 0)) return empty("stopFailure", `Price is already ${long ? "below" : "above"} ${invalidationName}; the thesis has failed.`);
  const stopPips = risk / pip;
  if (risk > settings.maxStopAtr * atr) {
    return empty("stopFailure", `The structural stop is ${stopPips.toFixed(1)} pips away (${(risk / atr).toFixed(1)} ATR), beyond the ${settings.maxStopAtr} ATR limit for this setup.`, { stopPips });
  }

  // Obstacles ahead: structural/higher-timeframe zones and the impulse extreme.
  const ahead = (price: number) => (long ? price > entry : price < entry);
  const usable = zones.filter((zone) => zone.status === "ACTIVE" || zone.flipped);
  const zoneEdge = (zone: SrZone) => (long ? zone.low : zone.high);
  const major: Obstacle[] = usable
    .filter((zone) => zone.relevance !== "MINOR" && ahead(zoneEdge(zone)))
    .map((zone) => ({ price: zoneEdge(zone), label: `${zone.sources.join("+")} ${long ? "resistance" : "support"} ${zone.low.toFixed(digits)}–${zone.high.toFixed(digits)}` }));
  if (pullback.start && ahead(pullback.start.price)) {
    major.push({ price: pullback.start.price, label: `the impulse ${long ? "high" : "low"} ${pullback.start.price.toFixed(digits)}` });
  }
  const obstacle = major.sort((a, b) => (long ? a.price - b.price : b.price - a.price))[0] ?? null;
  const obstacleBuffer = settings.obstacleBufferAtr * atr + spread;
  const room = obstacle ? Math.abs(obstacle.price - entry) - obstacleBuffer : Number.POSITIVE_INFINITY;
  const required = settings.minRewardRisk * risk;
  const context = { stopPips, roomPips: Number.isFinite(room) ? room / pip : null, requiredPips: required / pip, obstacle };
  if (room < required) {
    return empty("targetFailure", obstacle
      ? `Only ${(Math.max(0, room) / pip).toFixed(1)} pips to ${obstacle.label}; ${settings.minRewardRisk}R needs ${(required / pip).toFixed(1)} pips.`
      : "No room to a target.", context);
  }
  const preferred = settings.targetPreferencePips !== null ? settings.targetPreferencePips * pip : null;
  let distance: number;
  let targetBasis: string;
  if (preferred !== null) {
    // NORMAL: the preference when it fits, otherwise the minimum R, never past the obstacle.
    distance = Math.min(room, Math.max(preferred, required));
    targetBasis = distance === room && obstacle
      ? `Just before ${obstacle.label}`
      : distance === preferred ? `${settings.targetPreferencePips}-pip day-trade target; ${obstacle ? `${obstacle.label} is further` : "no structural obstacle before it"}`
        : `${settings.minRewardRisk}R minimum (${settings.targetPreferencePips} pips is under ${settings.minRewardRisk}R for this stop)`;
  } else if (obstacle) {
    distance = room;
    targetBasis = `Just before ${obstacle.label}`;
  } else {
    distance = required;
    targetBasis = `No structural obstacle ahead; target set at the ${settings.minRewardRisk}R minimum`;
  }
  if (settings.maxTargetPips !== null && distance / pip > settings.maxTargetPips) {
    return empty("targetFailure", `The target would need ${(distance / pip).toFixed(1)} pips, past the ${settings.maxTargetPips}-pip day-trade horizon.`, context);
  }

  const stop = roundPrice(instrument, stopRaw);
  const roundedEntry = roundPrice(instrument, entry);
  let target = roundPrice(instrument, long ? entry + distance : entry - distance);
  // Rounding to the instrument's precision can leave a target set at exactly
  // the minimum R a hair short of it; move it out a tick or two, never past
  // the obstacle's room.
  const tick = 10 ** -digits;
  for (let step = 0; step < 3; step += 1) {
    const r = executableRewardRisk(side, roundedEntry, stop, target);
    if (r === null || r >= settings.minRewardRisk) break;
    const next = roundPrice(instrument, long ? target + tick : target - tick);
    if (Math.abs(next - roundedEntry) > room) break;
    target = next;
  }
  const rewardRisk = executableRewardRisk(side, roundedEntry, stop, target);
  if (!levelsAreOrdered(side, roundedEntry, stop, target) || rewardRisk === null) {
    return empty("rulesFailure", `Levels are not ordered for a ${side.toLowerCase()} (entry ${roundedEntry}, stop ${stop}, target ${target}).`, context);
  }
  const minorObstacles = usable
    .filter((zone) => zone.relevance === "MINOR")
    .map((zone) => ({ price: zoneEdge(zone), label: `minor ${long ? "resistance" : "support"} ${zone.low.toFixed(digits)}–${zone.high.toFixed(digits)}` }))
    .filter((item) => ahead(item.price) && (long ? item.price < target : item.price > target));
  const finalStopPips = Math.abs(roundedEntry - stop) / pip;
  return {
    plan: {
      side,
      entry: roundedEntry,
      stop,
      target,
      invalidationLevel: invalidation,
      bufferPips: buffer / pip,
      stopPips: finalStopPips,
      targetPips: Math.abs(target - roundedEntry) / pip,
      rewardRisk,
      spreadPips: quote.spreadPips,
      spreadShare: quote.spreadPips / finalStopPips,
      stopBasis: `${long ? "Below" : "Above"} ${invalidationName} ${invalidation.toFixed(digits)}, plus ${(buffer / pip).toFixed(1)} pips (${settings.stopBufferAtr} ATR + spread)`,
      targetBasis,
      obstacle,
      minorObstacles,
    },
    stopFailure: null,
    targetFailure: null,
    rulesFailure: null,
    ...context,
    minorObstacles,
  };
}
