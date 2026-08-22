import { query } from "./database.js";
import { dayTradingSession } from "../../frontend/src/lib/strategy/strategy-engine.js";
import { LIVE_EXECUTABLE_FAMILIES } from "../../frontend/src/lib/strategy/strategies/index.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { MarketRegime, StrategyFamily } from "../../frontend/src/lib/strategy/types.js";

/**
 * Adaptive Engine V1.
 *
 * Sits above the four independent strategies. It does NOT invent trades: the
 * strategies generate candidates and the engine decides which single candidate
 * (if any) an instrument should attempt, since the pipeline allows one open
 * position per instrument. Everything else is recorded, never discarded.
 *
 * It is deliberately conservative and statistical — no ML, no future data. Its
 * authority grows only as resolved evidence accumulates:
 *
 *   COLLECTING        no trustworthy evidence yet → a stable deterministic
 *                     tie-break decides conflicts; never suppresses a lone
 *                     candidate.
 *   LEARNING          some evidence → historical expectancy ranks simultaneous
 *                     candidates; still never suppresses a lone candidate.
 *   ACTIVE_SELECTION  enough evidence for a context → may prefer the stronger
 *                     candidate and may suppress a demonstrably negative one,
 *                     up to and including selecting NONE.
 *
 * The core `decideInstrument` is pure and unit-tested; evidence loading and
 * decision logging are the only database-touching parts.
 */

export type AdaptiveState = "collecting" | "learning" | "active_selection";

/** Raw accumulators for one performance bucket; derived stats computed below. */
export interface BucketStat {
  resolved: number;
  wins: number;
  netR: number;
  sumSqR: number;
  mfe: number | null;
  mae: number | null;
}

export function expectancy(stat: BucketStat): number | null {
  return stat.resolved > 0 ? stat.netR / stat.resolved : null;
}

export function winRate(stat: BucketStat): number | null {
  return stat.resolved > 0 ? stat.wins / stat.resolved : null;
}

/** Sample standard error of the mean R. Null below two resolved observations. */
export function stdErr(stat: BucketStat): number | null {
  if (stat.resolved < 2) return null;
  const mean = stat.netR / stat.resolved;
  const variance = Math.max(0, (stat.sumSqR - stat.resolved * mean * mean) / (stat.resolved - 1));
  return Math.sqrt(variance / stat.resolved);
}

export interface AdaptiveConfig {
  /** Resolved observations before a context leaves COLLECTING. */
  minLearningSample: number;
  /** Resolved observations before a context may reach ACTIVE_SELECTION. */
  minActiveSample: number;
  /** One-sided z for the "demonstrably negative" confidence bound. */
  confidenceZ: number;
  /** Stable cold-start tie-break order. Not a claim of superiority. */
  familyPriority: StrategyFamily[];
}

/**
 * Conservative, context-specific evidence thresholds. These are the single
 * source of truth for the state machine — no sample-size magic numbers live
 * anywhere else. "Resolved observations" are always counted per context bucket
 * (family, pair, session, regime, direction), never as a global total, so 100
 * trades spread across unrelated pairs/regimes never unlock ACTIVE_SELECTION for
 * a specific context.
 *
 *   COLLECTING        0–49    observe only; cold-start conflict handling; a lone
 *                             candidate is NEVER suppressed on past performance.
 *   LEARNING          50–99   expectancy may rank/tie-break simultaneous
 *                             candidates; a standalone candidate is still never
 *                             suppressed on past performance.
 *   ACTIVE_SELECTION  100+    may suppress a candidate or select NONE — but only
 *                             when the statistical negative-expectancy confidence
 *                             test ALSO passes. Sample count alone is never enough.
 */
export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  minLearningSample: 50,
  minActiveSample: 100,
  confidenceZ: 1.64,
  familyPriority: ["ema", "breakout", "momentum", "meanrev"],
};

/** Minimal candidate view the engine reasons about. */
export interface AdaptiveCandidate {
  family: StrategyFamily;
  version: string;
  configVersion: string;
  direction: "long" | "short" | null;
  executable: boolean;
  riskReward: number | null;
  /** Number of passed conditions — a deterministic setup-quality proxy. */
  quality: number;
}

export interface EvidenceStore {
  totalResolved: number;
  /** key = contextKey(...); holds every level of {@link contextKeysFor}. */
  context: Map<string, BucketStat>;
}

export function contextKey(family: string, pair: string, session: string, regime: string, direction: string): string {
  return [family, pair, session, regime, direction].join("|");
}

/** Marks a dimension that a bucket has aggregated over. */
export const ANY = "*";

/**
 * The evidence ladder for one candidate, most specific first.
 *
 * The engine used to read one bucket only — the fully specific
 * (family, pair, session, regime, direction). With twelve pairs, three sessions,
 * three regimes and two directions that is ~216 buckets per family, each needing
 * 100 resolved observations before the engine may suppress anything: roughly
 * 21,600 trades per family. At the collector's real rate those thresholds are
 * unreachable, so every decision ever made stayed in COLLECTING and a
 * demonstrably losing strategy could never be switched off. The gate was not
 * conservative, it was inert.
 *
 * Pair and session are dropped first because they are the high-cardinality,
 * low-mechanism dimensions — they multiply the bucket count 36-fold while a
 * strategy's edge usually lives in how it interacts with the regime and its
 * direction. Dropping them recovers that factor of 36 immediately.
 *
 * This deliberately allows evidence to generalise across pairs and sessions,
 * which the fully specific key was designed to prevent. The trade is explicit:
 * a specific bucket still wins whenever it has the samples to speak for itself,
 * and generalisation only ever happens through a coarser bucket that has met the
 * same sample threshold on its own.
 */
export function contextKeysFor(family: string, pair: string, session: string, regime: string, direction: string): string[] {
  return [
    contextKey(family, pair, session, regime, direction),
    contextKey(family, ANY, ANY, regime, direction),
    contextKey(family, ANY, ANY, regime, ANY),
    contextKey(family, ANY, ANY, ANY, ANY),
  ];
}

/** Human-readable name for each ladder level, for the audit log. */
export const EVIDENCE_SCOPES = ["pair+session+regime+direction", "regime+direction", "regime", "family"] as const;

export interface AdaptiveInput {
  instrument: string;
  session: string;
  regime: MarketRegime;
  candidates: AdaptiveCandidate[];
  evidence: EvidenceStore;
  config?: AdaptiveConfig;
}

export interface AdaptiveDecision {
  state: AdaptiveState;
  selected: AdaptiveCandidate | null;
  suppressed: AdaptiveCandidate[];
  reason: string;
  /** The per-candidate evidence the decision considered, for the audit log. */
  evidenceUsed: Record<string, { resolved: number; expectancyR: number | null; winRate: number | null; scope: string | null }>;
}

export function toAdaptiveCandidate(candidate: StrategyCandidate): AdaptiveCandidate {
  const liveAllowed = LIVE_EXECUTABLE_FAMILIES.includes(candidate.family);
  return {
    family: candidate.family,
    version: candidate.version,
    configVersion: candidate.configVersion,
    direction: candidate.direction,
    executable: liveAllowed
      && candidate.status === "valid" && candidate.direction !== null
      && candidate.entry !== null && candidate.stop !== null && candidate.target !== null,
    riskReward: candidate.riskReward,
    quality: candidate.passedConditions.length,
  };
}

/**
 * The one decision, per instrument, at one moment. Pure: no I/O, no clock, and
 * it reads only the evidence handed to it — which the loader builds exclusively
 * from already-resolved trades, so the engine can never see a future outcome.
 */
export function decideInstrument(input: AdaptiveInput): AdaptiveDecision {
  const config = input.config ?? DEFAULT_ADAPTIVE_CONFIG;
  const executable = input.candidates.filter((candidate) => candidate.executable && candidate.direction);

  // The most specific bucket carrying at least `minimum` resolved observations.
  // Specific beats general, but only when it can speak for itself: a coarser
  // bucket is consulted only because every more specific one is too thin, and it
  // must clear the same threshold on its own before it is read.
  const resolveStat = (candidate: AdaptiveCandidate, minimum: number): { stat: BucketStat; scope: string } | null => {
    const keys = contextKeysFor(candidate.family, input.instrument, input.session, input.regime.regime, candidate.direction!);
    for (const [level, key] of keys.entries()) {
      const stat = input.evidence.context.get(key);
      if (stat && stat.resolved >= minimum) return { stat, scope: EVIDENCE_SCOPES[level]! };
    }
    return null;
  };
  // Ranking may read a bucket once it is out of cold start; suppression demands
  // the full active-selection sample in whichever bucket answers.
  const rankingStat = (candidate: AdaptiveCandidate) => resolveStat(candidate, config.minLearningSample);
  const suppressionStat = (candidate: AdaptiveCandidate) => resolveStat(candidate, config.minActiveSample);

  const evidenceUsed: AdaptiveDecision["evidenceUsed"] = {};
  for (const candidate of executable) {
    const found = rankingStat(candidate);
    evidenceUsed[`${candidate.family}:${candidate.direction}`] = {
      resolved: found?.stat.resolved ?? 0,
      expectancyR: found ? expectancy(found.stat) : null,
      winRate: found ? winRate(found.stat) : null,
      scope: found?.scope ?? null,
    };
  }

  // Engine maturity for THIS decision, expressed as what the evidence actually
  // permits rather than a raw count: ACTIVE_SELECTION only once some candidate
  // has a bucket big enough to suppress from, LEARNING once one is big enough to
  // rank by. An unproven context still stays in cold start.
  const state: AdaptiveState = executable.some((candidate) => suppressionStat(candidate)) ? "active_selection"
    : executable.some((candidate) => rankingStat(candidate)) ? "learning" : "collecting";

  const familyIndex = (candidate: AdaptiveCandidate) => {
    const index = config.familyPriority.indexOf(candidate.family);
    return index === -1 ? config.familyPriority.length : index;
  };
  // Stable deterministic tie-break: better setup quality, then reward-to-risk,
  // then the fixed family order. Used whenever there is no usable evidence.
  const coldRank = (a: AdaptiveCandidate, b: AdaptiveCandidate) =>
    b.quality - a.quality || (b.riskReward ?? 0) - (a.riskReward ?? 0) || familyIndex(a) - familyIndex(b);

  // Point-estimate expectancy, treating an unproven bucket as neutral (0), so a
  // proven-positive candidate beats an unknown and an unknown beats a
  // proven-negative one. Cold rank breaks ties.
  const evidenceRank = (a: AdaptiveCandidate, b: AdaptiveCandidate) => {
    const ea = evidenceExpectancy(a); const eb = evidenceExpectancy(b);
    return eb - ea || coldRank(a, b);
  };
  const evidenceExpectancy = (candidate: AdaptiveCandidate) => {
    const found = rankingStat(candidate);
    return found ? expectancy(found.stat) ?? 0 : 0;
  };

  const demonstrablyNegative = (candidate: AdaptiveCandidate): boolean => {
    const found = suppressionStat(candidate);
    if (!found) return false;
    const stat = found.stat;
    const mean = expectancy(stat); const se = stdErr(stat);
    if (mean === null || se === null) return false;
    // Even the optimistic bound is below zero → the edge is confidently negative.
    return mean + config.confidenceZ * se < 0;
  };

  const none = (reason: string): AdaptiveDecision => ({ state, selected: null, suppressed: executable, reason, evidenceUsed });

  if (executable.length === 0) {
    return { state, selected: null, suppressed: [], reason: "No executable candidate at this instrument.", evidenceUsed };
  }

  if (state === "collecting") {
    const ordered = [...executable].sort(coldRank);
    const [selected, ...rest] = ordered;
    const reason = executable.length === 1
      ? "Cold start: the only valid candidate is taken, pending evidence."
      : `Cold start: deterministic tie-break selected ${selected!.family} ${selected!.direction} over ${rest.map((r) => r.family).join(", ")}.`;
    return { state, selected: selected!, suppressed: rest, reason, evidenceUsed };
  }

  if (state === "learning") {
    const ordered = [...executable].sort(evidenceRank);
    const [selected, ...rest] = ordered;
    const reason = executable.length === 1
      ? "Learning: lone candidate taken; evidence not yet used to suppress it."
      : `Learning: ranked by historical expectancy, selected ${selected!.family} ${selected!.direction}.`;
    return { state, selected: selected!, suppressed: rest, reason, evidenceUsed };
  }

  // ACTIVE_SELECTION
  const viable = executable.filter((candidate) => !demonstrablyNegative(candidate));
  const suppressedNegative = executable.filter((candidate) => demonstrablyNegative(candidate));
  if (viable.length === 0) {
    return none(`Active selection: every available candidate has a confidently negative edge under similar conditions (${suppressedNegative.map((c) => c.family).join(", ")}). No trade.`);
  }
  const ordered = [...viable].sort(evidenceRank);
  const [selected, ...rest] = ordered;
  const suppressed = [...rest, ...suppressedNegative];
  const reason = `Active selection: chose ${selected!.family} ${selected!.direction} by historical expectancy${suppressedNegative.length ? `; suppressed ${suppressedNegative.map((c) => c.family).join(", ")} as negative-edge` : ""}.`;
  return { state, selected: selected!, suppressed, reason, evidenceUsed };
}

// ---------------------------------------------------------------------------
// Database-backed evidence + decision logging.
// ---------------------------------------------------------------------------

const RESOLVED_SHADOW_OUTCOMES = "('target_first','stop_first','forced_close','timeout')";

/**
 * Build the evidence store from ALREADY-RESOLVED observations of the experiment:
 * executed trades AND resolved shadow outcomes of suppressed/blocked candidates.
 *
 * Two look-ahead guards, both at the data layer:
 *   - Executed: `status='closed' AND result_r IS NOT NULL` — an open or
 *     unresolved trade contributes nothing.
 *   - Shadow: only rows in `shadow_candidate_outcomes` (which the resolver writes
 *     ONLY once the outcome has actually occurred in real time) with a resolved,
 *     non-ambiguous result. A shadow outcome therefore cannot enter the evidence
 *     the engine reads until the moment it would genuinely have become known.
 *
 * Executed and shadow observations are merged into the same context bucket so a
 * strategy that is usually suppressed still accumulates evidence; they remain
 * separately reportable via `multiStrategyOverview`.
 *
 * `asOf` is the explicit look-ahead bound: only observations whose outcome had
 * resolved at or before `asOf` are counted (executed by `closed_at`, shadow by
 * `resolved_at`). Live callers pass the current time, so nothing that resolves
 * after the decision can ever be seen; a future replay MUST pass the decision
 * time so it, too, cannot read an outcome that had not yet occurred. Relying on
 * `status='closed'` alone is deliberately NOT trusted.
 */
export async function loadAdaptiveEvidence(experimentId: string, asOf: Date = new Date()): Promise<EvidenceStore> {
  const context = new Map<string, BucketStat>();
  const asOfIso = asOf.toISOString();
  let totalResolved = 0;
  const add = (key: string, resolved: number, wins: number, netR: number, sumSqR: number) => {
    const current = context.get(key) ?? { resolved: 0, wins: 0, netR: 0, sumSqR: 0, mfe: null, mae: null };
    current.resolved += resolved; current.wins += wins; current.netR += netR; current.sumSqR += sumSqR;
    context.set(key, current);
  };
  /**
   * Feed one observation (or one pre-grouped batch of them) into every level of
   * the ladder it belongs to. Sums, counts and sums-of-squares are all additive,
   * so an aggregate bucket built this way is identical to one computed directly
   * over the same rows — the coarser levels are a re-grouping of the same
   * observations, never a re-weighting of them.
   *
   * `totalResolved` counts each observation once, at the exact level only, so it
   * stays a true population count rather than a multiple of the ladder depth.
   */
  const merge = (family: string, pair: string, session: string, regime: string, direction: string, resolved: number, wins: number, netR: number, sumSqR: number) => {
    for (const key of contextKeysFor(family, pair, session, regime, direction)) add(key, resolved, wins, netR, sumSqR);
    totalResolved += resolved;
  };

  const executed = await query<{ strategy_family: string; instrument: string; session: string; regime: string | null; direction: string; resolved: string; wins: string; net_r: string; sumsq_r: string }>(
    `SELECT strategy_family, instrument, session, COALESCE(regime,'mixed') AS regime,
            -- Evidence must be keyed by what the STRATEGY predicted, not by what
            -- an execution policy traded. The engine looks a candidate up by its
            -- own direction, so an inverted momentum trade has to land in the
            -- bucket the strategy will consult next time; otherwise selection and
            -- evidence key on opposite directions and the engine learns nothing
            -- it can use. The OUTCOME attached is the realised executed result,
            -- which is correct: under a fixed policy the engine is learning
            -- "when momentum says X here, what the policy produces is Y".
            COALESCE(original_direction, direction) AS direction,
            count(*)::text AS resolved,
            count(*) FILTER (WHERE result_r > 0)::text AS wins,
            COALESCE(sum(result_r),0)::text AS net_r,
            COALESCE(sum(result_r * result_r),0)::text AS sumsq_r
       FROM paper_strategy_trades
      WHERE experiment_id = $1 AND strategy_family IS NOT NULL
        AND status = 'closed' AND result_r IS NOT NULL
        AND closed_at IS NOT NULL AND closed_at <= $2
      GROUP BY strategy_family, instrument, session, COALESCE(regime,'mixed'), COALESCE(original_direction, direction)`,
    [experimentId, asOfIso],
  );
  for (const row of executed.rows) {
    merge(row.strategy_family, row.instrument, row.session, row.regime ?? "mixed", row.direction, Number(row.resolved), Number(row.wins), Number(row.net_r), Number(row.sumsq_r));
  }

  // Shadow outcomes carry no session column, so the session is derived in JS from
  // the decision time with the same function that stamped the executed trades —
  // keeping the two sources in identical context buckets.
  const shadow = await query<{ strategy_family: string; instrument: string; decision_time: string | Date; regime: string | null; direction: string; result_r: string }>(
    `SELECT e.strategy_family, e.instrument, e.decision_time, COALESCE(e.regime,'mixed') AS regime,
            COALESCE(e.original_direction, e.direction) AS direction, s.result_r::text
       FROM shadow_candidate_outcomes s
       JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
      WHERE e.experiment_id = $1 AND e.strategy_family IS NOT NULL AND e.direction IS NOT NULL
        AND s.result_r IS NOT NULL AND s.outcome IN ${RESOLVED_SHADOW_OUTCOMES}
        AND s.resolved_at IS NOT NULL AND s.resolved_at <= $2`,
    [experimentId, asOfIso],
  );
  for (const row of shadow.rows) {
    const session = dayTradingSession(new Date(row.decision_time)).label;
    const resultR = Number(row.result_r);
    if (!Number.isFinite(resultR)) continue;
    merge(row.strategy_family, row.instrument, session, row.regime ?? "mixed", row.direction, 1, resultR > 0 ? 1 : 0, resultR, resultR * resultR);
  }

  return { totalResolved, context };
}
