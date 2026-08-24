import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";

/**
 * Adaptive evidence integrity — the deterministic core.
 *
 * Pure: no clock, no database, no network. Every function here is a total
 * function of its inputs, so the repair command, the live collector and the
 * tests all compute the same answer from the same row, and re-running a repair
 * rewrites identical values.
 *
 * Three concerns live here, and they are the three the prerequisite audit found
 * were not being recorded honestly:
 *
 *   COST      what the trade actually paid in friction, expressed in R
 *   NEWS      whether a news classification can be believed at all
 *   IDENTITY  what counts as ONE adaptive observation
 */

// ---------------------------------------------------------------------------
// Cost, in R
// ---------------------------------------------------------------------------

/**
 * WHY net_result_r EQUALS result_r.
 *
 * The audit traced the resolvers before assuming a bug, and the spread is
 * already fully charged in the stored figure:
 *
 *   - `buildTradePlan` takes entry on the EXECUTABLE side — the ask for a long,
 *     the bid for a short — so the fill price already includes half the spread.
 *   - `labelOutcome` resolves a long against `bidHigh`/`bidLow` and a short
 *     against `askLow`/`askHigh`, i.e. the exit is measured on the OPPOSITE side
 *     of the book from the entry.
 *
 * Mid-to-mid, that round trip costs exactly one full spread. So result_r is a
 * NET figure, and the useful decomposition runs the other way: gross is
 * reconstructed by adding the friction back, not by subtracting it.
 *
 * This matters because the obvious "fix" — subtracting a spread cost from
 * result_r — would charge the spread twice and manufacture a loss that was
 * never paid. The identity below is the one that holds:
 *
 *      net_result_r = gross_result_r - total_cost_r
 *      gross_result_r = net_result_r + total_cost_r
 */
export type CostBasis = "spread_only" | "spread_and_broker" | "unknown";
export type ResultBasis = "broker" | "model" | "unknown";

export interface CostInputs {
  instrument: string;
  entry: number | null;
  stop: number | null;
  spreadPips: number | null;
  /** The stored, already-net result. Null while the trade is unresolved. */
  resultR: number | null;
  /** Positive R lost to commission, when the broker actually reported it. */
  commissionCostR?: number | null;
  /** Positive R lost to slippage, when both a modelled and a filled R exist. */
  slippageCostR?: number | null;
  /** Which resolver produced resultR. */
  resultBasis?: ResultBasis;
}

export interface CostDecomposition {
  spreadCostR: number | null;
  commissionCostR: number | null;
  slippageCostR: number | null;
  totalCostR: number | null;
  grossResultR: number | null;
  netResultR: number | null;
  costBasis: CostBasis;
  /** Why a component could not be computed. Empty when everything resolved. */
  unknownReasons: string[];
}

/**
 * The spread the trade crossed, in units of its own risk.
 *
 * `spread_pips * pipSize` is the price the round trip costs; dividing by the
 * stop distance converts it into R, which is the unit every other statistic in
 * the system is already expressed in. A 1.4-pip spread on a 7-pip stop is 0.20R
 * — which is why this is not a rounding detail.
 *
 * Returns null rather than a guess when any input is missing or degenerate.
 */
export function spreadCostR(input: {
  instrument: string;
  entry: number | null;
  stop: number | null;
  spreadPips: number | null;
}): number | null {
  const { instrument, entry, stop, spreadPips } = input;
  if (entry === null || stop === null || spreadPips === null) return null;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(spreadPips)) return null;
  if (spreadPips < 0) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const pip = pipSizeFor(instrument);
  if (!Number.isFinite(pip) || !(pip > 0)) return null;
  const cost = (spreadPips * pip) / risk;
  return Number.isFinite(cost) ? cost : null;
}

/**
 * Decompose one resolved trade into gross result, friction and net result.
 *
 * An unknown component stays null and is NOT silently treated as zero — but it
 * is also not allowed to poison the total, so `costBasis` records exactly which
 * components `totalCostR` contains. A caller comparing two trades can therefore
 * tell a complete cost figure from a spread-only one instead of assuming.
 */
export function decomposeCost(input: CostInputs): CostDecomposition {
  const unknownReasons: string[] = [];
  const spread = spreadCostR(input);
  if (spread === null) unknownReasons.push("spread_cost_r: missing or degenerate spread/entry/stop");

  const commission = numberOrNull(input.commissionCostR);
  const slippage = numberOrNull(input.slippageCostR);
  if (commission === null) unknownReasons.push("commission_cost_r: the broker does not report commission or financing");
  if (slippage === null) unknownReasons.push("slippage_cost_r: no modelled-vs-filled pair is stored for this trade");

  const netResultR = numberOrNull(input.resultR);
  if (netResultR === null) unknownReasons.push("net_result_r: the trade has no resolved result_r");

  // Only components that are actually known are summed, and costBasis says so.
  const known = [spread, commission, slippage].filter((value): value is number => value !== null);
  const totalCostR = spread === null ? null : known.reduce((sum, value) => sum + value, 0);

  const costBasis: CostBasis = spread === null ? "unknown"
    : commission !== null || slippage !== null ? "spread_and_broker"
      : "spread_only";

  const grossResultR = netResultR === null || totalCostR === null ? null : netResultR + totalCostR;

  return { spreadCostR: spread, commissionCostR: commission, slippageCostR: slippage, totalCostR, grossResultR, netResultR, costBasis, unknownReasons };
}

/** The identity every cost decomposition must satisfy, to within float noise. */
export function costIdentityHolds(decomposition: CostDecomposition, tolerance = 1e-9): boolean {
  const { grossResultR, totalCostR, netResultR } = decomposition;
  if (grossResultR === null || totalCostR === null || netResultR === null) return true;
  return Math.abs(netResultR - (grossResultR - totalCostR)) <= tolerance;
}

function numberOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// News classification state
// ---------------------------------------------------------------------------

/**
 * Whether a news tag can be believed.
 *
 *   EVALUATED                    a calendar covering this instant was consulted
 *   NOT_EVALUATED                no classification was ever run for this trade
 *   INSUFFICIENT_CALENDAR_DATA   a classification ran, but the stored calendar
 *                                does not cover this instant, so its NO_NEWS is
 *                                an absence of DATA, not an absence of NEWS
 */
export type NewsEvaluationState = "EVALUATED" | "NOT_EVALUATED" | "INSUFFICIENT_CALENDAR_DATA";

/** The tag domain, widened so "no data" stops being spelled the same as "quiet". */
export const NEWS_TAGS = [
  "NO_NEWS", "NEAR_NEWS", "HIGH_IMPACT_NEWS", "INSUFFICIENT_CALENDAR_DATA", "NOT_EVALUATED",
] as const;
export type PersistedNewsTag = (typeof NEWS_TAGS)[number];

/** Tags that assert a positive fact about news being present. */
export const NEWS_PRESENT_TAGS: readonly PersistedNewsTag[] = ["NEAR_NEWS", "HIGH_IMPACT_NEWS"];

export interface NewsClassificationInput {
  /** What the pure classifier concluded, or null when it never ran. */
  classifiedTag: "NO_NEWS" | "NEAR_NEWS" | "HIGH_IMPACT_NEWS" | null;
  /**
   * How many calendar events are stored anywhere near this trade, for ANY
   * currency. This is the coverage question — not "was there news for this
   * pair", but "did the calendar have anything to say about this moment at all".
   */
  calendarEventsNearby: number | null;
}

export interface NewsClassification {
  tag: PersistedNewsTag;
  state: NewsEvaluationState;
}

/**
 * Turn a raw classifier verdict plus calendar coverage into what should be
 * stored.
 *
 * The one rule that matters: a NO_NEWS verdict produced against a calendar that
 * does not cover the trade is downgraded to INSUFFICIENT_CALENDAR_DATA. A
 * positive match (NEAR/HIGH) is never downgraded — an event was actually found,
 * so coverage is proven by the match itself.
 */
export function classifyNewsPersistence(input: NewsClassificationInput): NewsClassification {
  const { classifiedTag, calendarEventsNearby } = input;
  if (classifiedTag === null) return { tag: "NOT_EVALUATED", state: "NOT_EVALUATED" };
  if (NEWS_PRESENT_TAGS.includes(classifiedTag)) return { tag: classifiedTag, state: "EVALUATED" };
  // classifiedTag is NO_NEWS from here.
  const covered = calendarEventsNearby !== null && calendarEventsNearby > 0;
  return covered
    ? { tag: "NO_NEWS", state: "EVALUATED" }
    : { tag: "INSUFFICIENT_CALENDAR_DATA", state: "INSUFFICIENT_CALENDAR_DATA" };
}

/** The invariant: missing calendar coverage must never read as confirmed quiet. */
export function newsTagIsHonest(tag: string | null, calendarEventsNearby: number | null): boolean {
  if (tag !== "NO_NEWS") return true;
  return calendarEventsNearby !== null && calendarEventsNearby > 0;
}

// ---------------------------------------------------------------------------
// Observation identity
// ---------------------------------------------------------------------------

/**
 * WHAT COUNTS AS ONE ADAPTIVE OBSERVATION.
 *
 * One strategy ARM at one OPPORTUNITY. Concretely:
 *
 *     experiment . family . config_version . instrument . decision_time . strategy_direction
 *
 * `strategy_direction` is COALESCE(original_direction, direction) — what the
 * STRATEGY concluded, not what an execution policy traded — because that is the
 * key the engine looks a candidate up by on the next bar.
 *
 * config_version is part of the identity on purpose: a parameter change is a
 * different strategy, and pooling two config versions into one bucket would
 * quietly average two different experiments.
 *
 * decision_time (the completed M15 bar) rather than opened_at, because the
 * collector runs far more often than every fifteen minutes and every tick inside
 * the same bar is the SAME opportunity, not a new one.
 *
 * The rule that follows: an opportunity contributes EITHER its executed result
 * OR its hypothetical shadow result, never both.
 */
export interface ObservationIdentity {
  experimentId: string;
  family: string;
  configVersion: string;
  instrument: string;
  decisionTime: string;
  strategyDirection: string;
}

export function observationKey(identity: ObservationIdentity): string {
  return [
    identity.experimentId,
    identity.family,
    identity.configVersion,
    identity.instrument,
    // Normalised to an epoch so two spellings of the same instant collapse to
    // one key. A raw ISO string would treat "...T13:15:00Z" and
    // "...T09:15:00-04:00" as two different opportunities.
    normalizedInstant(identity.decisionTime),
    identity.strategyDirection,
  ].join("|");
}

/** Epoch milliseconds as a string, or the raw value when it will not parse. */
export function normalizedInstant(value: string | Date): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? String(ms) : String(value);
}

/**
 * Find observations that describe the same opportunity+arm more than once.
 *
 * Returns one entry per duplicated key with the sources that collided, which is
 * what the integrity report prints. An empty result is the invariant holding.
 */
export function findDuplicateObservations<T extends ObservationIdentity & { source: string }>(
  observations: readonly T[],
): Array<{ key: string; sources: string[]; count: number }> {
  const byKey = new Map<string, T[]>();
  for (const observation of observations) {
    const key = observationKey(observation);
    byKey.set(key, [...(byKey.get(key) ?? []), observation]);
  }
  return [...byKey.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, sources: items.map((item) => item.source).sort(), count: items.length }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Momentum pairing
// ---------------------------------------------------------------------------

export type MomentumArm = "original" | "inverted";

/**
 * The deterministic pair id.
 *
 * Derived from the opportunity rather than generated, so recording the same bar
 * twice yields the same pair and the write is idempotent. Computed in SQL as
 * `md5(...)::uuid` over the identical string, so both sides always agree.
 */
export function momentumPairKey(experimentId: string, instrument: string, decisionTime: string | Date): string {
  return `${experimentId}|${instrument}|${new Date(decisionTime).toISOString()}`;
}

/** The arm that a given executed direction belongs to, for a known original. */
export function armForExecutedDirection(originalDirection: "long" | "short", executedDirection: "long" | "short"): MomentumArm {
  return executedDirection === originalDirection ? "original" : "inverted";
}

/** The direction of the opposite arm. Inversion is exactly a direction flip. */
export function oppositeDirection(direction: "long" | "short"): "long" | "short" {
  return direction === "long" ? "short" : "long";
}

export interface MomentumArmGeometry {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  stopDistance: number;
  targetDistance: number;
}

/**
 * Build both arms of one Momentum opportunity from the original candidate.
 *
 * The inverted arm is REBUILT on the opposite side of the book at the same
 * instant — never negated — so it pays its own real spread instead of being
 * handed a free round trip. Stop and target DISTANCES are preserved exactly and
 * mirrored, so reward-to-risk is identical across the pair and the only
 * difference between the two arms is direction. This is the same construction
 * `applyMomentumInversion` performs for the executed arm, kept in one place so
 * the research record and the live trade can never disagree about geometry.
 *
 * Returns null when the opportunity cannot be priced on both sides, because a
 * pair with one guessed arm is worse than no pair.
 */
export function buildMomentumArms(input: {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  quote: { bid: number; ask: number };
}): { original: MomentumArmGeometry; inverted: MomentumArmGeometry } | null {
  const { direction, entry, stop, target, quote } = input;
  if (![entry, stop, target, quote.bid, quote.ask].every((value) => Number.isFinite(value) && value > 0)) return null;

  const stopDistance = Math.abs(entry - stop);
  const targetDistance = Math.abs(target - entry);
  if (!(stopDistance > 0) || !(targetDistance > 0)) return null;

  const invertedDirection = oppositeDirection(direction);
  const invertedEntry = invertedDirection === "long" ? quote.ask : quote.bid;
  const invertedStop = invertedDirection === "long" ? invertedEntry - stopDistance : invertedEntry + stopDistance;
  const invertedTarget = invertedDirection === "long" ? invertedEntry + targetDistance : invertedEntry - targetDistance;

  return {
    original: { direction, entry, stop, target, stopDistance, targetDistance },
    inverted: {
      direction: invertedDirection, entry: invertedEntry, stop: invertedStop, target: invertedTarget,
      stopDistance, targetDistance,
    },
  };
}
