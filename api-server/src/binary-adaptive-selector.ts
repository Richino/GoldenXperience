import { query } from "./database.js";
import {
  buildPairedDisagreementEvidence,
  buildSelectorSelfEvaluation,
  loadAdaptivePredictionRows,
  type AdaptivePredictionRow,
  type PairedDisagreementEvidence,
  type SelectorSelfEvaluation,
} from "./binary-adaptive-stats.js";
import { BINARY_MODEL_NAME } from "./binary-engine.js";
import { BINARY_LOGISTIC_MODEL_NAME } from "./binary-logistic-v1.js";
import {
  deriveRegimeDescriptor,
  evidenceLabel,
  wilsonInterval,
  type BinaryRegimeDescriptor,
  type EvidenceLabel,
} from "./binary-regimes.js";
import type { BinaryFeatures } from "./binary-engine.js";

export const BINARY_ADAPTIVE_SELECTOR_VERSION = "binary-adaptive-selector-v1";

export type SelectorState = "COLLECTING" | "LEARNING" | "ACTIVE_SELECTION";

export type BinaryAdaptiveSelectorConfig = {
  minLearningPairedSamples: number;
  minActivePairedSamples: number;
  minRegimeDecisiveDisagreements: number;
  minOverallDecisiveDisagreements: number;
  minimumEvidenceLabel: EvidenceLabel;
  requiredCIThreshold: number;
  minimumPracticalEdge: number;
  recentWindow: number;
  recentInstabilityMargin: number;
};

export const BINARY_ADAPTIVE_SELECTOR_CONFIG: BinaryAdaptiveSelectorConfig = {
  minLearningPairedSamples: 50,
  minActivePairedSamples: 100,
  minRegimeDecisiveDisagreements: 30,
  minOverallDecisiveDisagreements: 50,
  minimumEvidenceLabel: "USABLE" as EvidenceLabel,
  requiredCIThreshold: 0.5,
  minimumPracticalEdge: 0.02,
  recentWindow: 50,
  recentInstabilityMargin: 0.05,
};

/** Evidence scopes searched from most specific to broadest. */
export const SELECTOR_EVIDENCE_SCOPES = [
  "instrument|session|atrRegime",
  "instrument|atrRegime",
  "atrRegime|volatilityRegime",
  "instrument|session",
  "overall",
] as const;

export type SelectorEvidenceScope = (typeof SELECTOR_EVIDENCE_SCOPES)[number];

export type SelectorEvidence = {
  scope: SelectorEvidenceScope;
  sampleSize: number;
  estimate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  baselineOnlyCorrect: number;
  logisticOnlyCorrect: number;
  evidence: EvidenceLabel;
};

export type SelectorDecision = {
  selectorVersion: string;
  state: SelectorState;
  selectedModel: typeof BINARY_MODEL_NAME | typeof BINARY_LOGISTIC_MODEL_NAME;
  authoritativeModel: typeof BINARY_MODEL_NAME | typeof BINARY_LOGISTIC_MODEL_NAME;
  recommendedModel: typeof BINARY_MODEL_NAME | typeof BINARY_LOGISTIC_MODEL_NAME;
  recommendationOnly: boolean;
  fallbackUsed: boolean;
  reason: string;
  evidence: SelectorEvidence;
  pairedSamples: number;
  regime: BinaryRegimeDescriptor;
};

export function isBinaryAdaptiveSelectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BINARY_ADAPTIVE_SELECTOR_ENABLED ?? "false").toLowerCase() === "true";
}

export function isBinaryAdaptiveLiveSelectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BINARY_ADAPTIVE_LIVE_SELECTION_ENABLED ?? "false").toLowerCase() === "true";
}

export function determineSelectorState(
  pairedSamples: number,
  config = BINARY_ADAPTIVE_SELECTOR_CONFIG,
): SelectorState {
  if (pairedSamples < config.minLearningPairedSamples) return "COLLECTING";
  if (pairedSamples < config.minActivePairedSamples) return "LEARNING";
  return "ACTIVE_SELECTION";
}

function scopeMatchesRegime(scope: SelectorEvidenceScope, regime: BinaryRegimeDescriptor): Record<string, string> {
  switch (scope) {
    case "instrument|session|atrRegime":
      return { instrument: regime.instrument, session: regime.session, atrRegime: regime.atrRegime };
    case "instrument|atrRegime":
      return { instrument: regime.instrument, atrRegime: regime.atrRegime };
    case "atrRegime|volatilityRegime":
      return { atrRegime: regime.atrRegime, volatilityRegime: regime.volatilityRegime };
    case "instrument|session":
      return { instrument: regime.instrument, session: regime.session };
    case "overall":
      return {};
    default: {
      const _exhaustive: never = scope;
      throw new Error(`Unknown selector evidence scope: ${_exhaustive}`);
    }
  }
}

function minSamplesForScope(scope: SelectorEvidenceScope, config = BINARY_ADAPTIVE_SELECTOR_CONFIG): number {
  return scope === "overall" ? config.minOverallDecisiveDisagreements : config.minRegimeDecisiveDisagreements;
}

function evaluateScopedEvidence(
  evidence: PairedDisagreementEvidence,
  scope: SelectorEvidenceScope,
  config = BINARY_ADAPTIVE_SELECTOR_CONFIG,
): SelectorEvidence {
  const decided = evidence.baselineOnlyCorrect + evidence.logisticOnlyCorrect;
  const { ciLow, ciHigh } = wilsonInterval(evidence.logisticOnlyCorrect, decided);
  return {
    scope,
    sampleSize: decided,
    estimate: decided > 0 ? evidence.logisticOnlyCorrect / decided : null,
    ciLow,
    ciHigh,
    baselineOnlyCorrect: evidence.baselineOnlyCorrect,
    logisticOnlyCorrect: evidence.logisticOnlyCorrect,
    evidence: evidenceLabel(decided),
  };
}

function meetsEvidenceQuality(label: EvidenceLabel, config = BINARY_ADAPTIVE_SELECTOR_CONFIG): boolean {
  const order: EvidenceLabel[] = ["INSUFFICIENT", "EARLY", "USABLE", "STRONG"];
  return order.indexOf(label) >= order.indexOf(config.minimumEvidenceLabel);
}

function credibleAdvantage(
  scoped: SelectorEvidence,
  config = BINARY_ADAPTIVE_SELECTOR_CONFIG,
): typeof BINARY_MODEL_NAME | typeof BINARY_LOGISTIC_MODEL_NAME | null {
  if (scoped.sampleSize === 0 || scoped.estimate == null || scoped.ciLow == null || scoped.ciHigh == null) return null;
  if (!meetsEvidenceQuality(scoped.evidence, config)) return null;

  const edge = Math.abs(scoped.estimate - config.requiredCIThreshold);
  if (edge < config.minimumPracticalEdge) return null;

  if (scoped.ciLow > config.requiredCIThreshold) return BINARY_LOGISTIC_MODEL_NAME;
  if (scoped.ciHigh < config.requiredCIThreshold) return BINARY_MODEL_NAME;
  return null;
}

function recentPairedGuardrail(
  rows: AdaptivePredictionRow[],
  preferred: typeof BINARY_MODEL_NAME | typeof BINARY_LOGISTIC_MODEL_NAME,
  config = BINARY_ADAPTIVE_SELECTOR_CONFIG,
): boolean {
  const paired = buildPairedDisagreementEvidence(rows.filter((row) => row.opportunityId != null), "overall");
  if (paired.chronologicalPairs.length < config.recentWindow) return true;

  const recent = paired.chronologicalPairs.slice(-config.recentWindow);
  let baselineWins = 0;
  let logisticWins = 0;
  for (const pair of recent) {
    if (pair.baseline.result === "won") baselineWins += 1;
    if (pair.logistic.result === "won") logisticWins += 1;
  }
  const baselineRate = baselineWins / recent.length;
  const logisticRate = logisticWins / recent.length;

  if (preferred === BINARY_LOGISTIC_MODEL_NAME) {
    return logisticRate + config.recentInstabilityMargin >= baselineRate;
  }
  return true;
}

export function selectBinaryModel(input: {
  regime: BinaryRegimeDescriptor;
  pairedRows: AdaptivePredictionRow[];
  state?: SelectorState;
  liveSelectionEnabled?: boolean;
  config?: BinaryAdaptiveSelectorConfig;
}): SelectorDecision {
  const config = input.config ?? BINARY_ADAPTIVE_SELECTOR_CONFIG;
  const pairedRows = input.pairedRows.filter((row) => row.opportunityId != null);
  const pairedSamples = new Set(
    pairedRows
      .filter((row) => row.status === "resolved" && row.result != null)
      .map((row) => row.opportunityId!),
  ).size;
  const state = input.state ?? determineSelectorState(pairedSamples, config);
  const liveSelectionEnabled = input.liveSelectionEnabled ?? false;

  const fallbackDecision = (
    reason: string,
    evidence: SelectorEvidence,
    fallbackUsed = true,
  ): SelectorDecision => ({
    selectorVersion: BINARY_ADAPTIVE_SELECTOR_VERSION,
    state,
    selectedModel: BINARY_MODEL_NAME,
    authoritativeModel: BINARY_MODEL_NAME,
    recommendedModel: BINARY_MODEL_NAME,
    recommendationOnly: state !== "ACTIVE_SELECTION" || !liveSelectionEnabled,
    fallbackUsed,
    reason,
    evidence,
    pairedSamples,
    regime: input.regime,
  });

  if (state === "COLLECTING") {
    return fallbackDecision(
      "insufficient_paired_samples",
      {
        scope: "overall",
        sampleSize: 0,
        estimate: null,
        ciLow: null,
        ciHigh: null,
        baselineOnlyCorrect: 0,
        logisticOnlyCorrect: 0,
        evidence: evidenceLabel(0),
      },
      false,
    );
  }

  for (const scope of SELECTOR_EVIDENCE_SCOPES) {
    const dimensions = scopeMatchesRegime(scope, input.regime);
    const scopedEvidence = buildPairedDisagreementEvidence(pairedRows, scope, dimensions);
    const evaluated = evaluateScopedEvidence(scopedEvidence, scope, config);
    if (evaluated.sampleSize < minSamplesForScope(scope, config)) continue;

    const advantage = credibleAdvantage(evaluated, config);
    if (!advantage) continue;
    if (!recentPairedGuardrail(pairedRows, advantage, config)) {
      return fallbackDecision("recent_performance_unstable", evaluated);
    }

    const recommendationOnly = state !== "ACTIVE_SELECTION" || !liveSelectionEnabled;
    const authoritativeModel = recommendationOnly ? BINARY_MODEL_NAME : advantage;
    return {
      selectorVersion: BINARY_ADAPTIVE_SELECTOR_VERSION,
      state,
      selectedModel: advantage,
      authoritativeModel,
      recommendedModel: advantage,
      recommendationOnly,
      fallbackUsed: authoritativeModel === BINARY_MODEL_NAME && advantage !== BINARY_MODEL_NAME,
      reason: recommendationOnly ? "learning_shadow_recommendation" : "credible_paired_advantage",
      evidence: evaluated,
      pairedSamples,
      regime: input.regime,
    };
  }

  const overall = evaluateScopedEvidence(
    buildPairedDisagreementEvidence(pairedRows, "overall"),
    "overall",
    config,
  );
  return fallbackDecision("no_credible_advantage", overall);
}

export function selectBinaryModelForFeatures(
  features: BinaryFeatures,
  instrument: string,
  confidence: number,
  scoreKind: "heuristic_score" | "probability",
  pairedRows: AdaptivePredictionRow[],
  options: {
    state?: SelectorState;
    liveSelectionEnabled?: boolean;
    config?: BinaryAdaptiveSelectorConfig;
  } = {},
): SelectorDecision {
  const regime = deriveRegimeDescriptor({ instrument, features, confidence, scoreKind });
  return selectBinaryModel({ regime, pairedRows, ...options });
}

export type SelectorStatus = {
  selectorVersion: string;
  state: SelectorState;
  config: BinaryAdaptiveSelectorConfig;
  pairedSamples: number;
  activeSelectionEligible: boolean;
  liveSelectionEnabled: boolean;
  selectorEnabled: boolean;
  recentDecisions: Array<{
    opportunityId: string;
    state: SelectorState;
    recommendedModel: string;
    authoritativeModel: string;
    reason: string;
    evidenceScope: string;
    sampleSize: number;
    resolvedAt: string | null;
  }>;
  performance: SelectorSelfEvaluation;
};

export function logBinarySelector(
  event: "collecting" | "recommendation" | "active" | "fallback" | "error",
  fields: Record<string, unknown>,
) {
  console.log(JSON.stringify({ event: `binary.selector.${event}`, selectorVersion: BINARY_ADAPTIVE_SELECTOR_VERSION, ...fields }));
}

export async function buildSelectorStatus(
  recentDecisions?: SelectorStatus["recentDecisions"],
): Promise<SelectorStatus> {
  const rows = await loadAdaptivePredictionRows();
  const decisions = recentDecisions ?? await loadRecentSelectorDecisions();
  const pairedSamples = new Set(
    rows.filter((row) => row.opportunityId && row.status === "resolved").map((row) => row.opportunityId!),
  ).size;
  const state = determineSelectorState(pairedSamples);
  const performance = buildSelectorSelfEvaluation(rows);
  return {
    selectorVersion: BINARY_ADAPTIVE_SELECTOR_VERSION,
    state,
    config: BINARY_ADAPTIVE_SELECTOR_CONFIG,
    pairedSamples,
    activeSelectionEligible: state === "ACTIVE_SELECTION",
    liveSelectionEnabled: isBinaryAdaptiveLiveSelectionEnabled(),
    selectorEnabled: isBinaryAdaptiveSelectorEnabled(),
    recentDecisions: decisions,
    performance,
  };
}

type SelectorDecisionRow = {
  opportunity_id: string;
  selector_state: SelectorState;
  recommended_model: string;
  authoritative_model: string;
  reason: string;
  evidence_scope: string;
  sample_size: number;
  resolved_at: string | null;
};

export async function loadRecentSelectorDecisions(limit = 20): Promise<SelectorStatus["recentDecisions"]> {
  const result = await query<SelectorDecisionRow>(
    `SELECT opportunity_id, selector_state, recommended_model, authoritative_model, reason,
            evidence_scope, sample_size, resolved_at
     FROM binary_selector_decisions
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return result.rows.map((row) => ({
    opportunityId: row.opportunity_id,
    state: row.selector_state,
    recommendedModel: row.recommended_model,
    authoritativeModel: row.authoritative_model,
    reason: row.reason,
    evidenceScope: row.evidence_scope,
    sampleSize: row.sample_size,
    resolvedAt: row.resolved_at,
  }));
}

export async function persistSelectorDecision(
  decision: SelectorDecision,
  opportunityId: string,
  baselinePredictionId: string | null,
  logisticPredictionId: string | null,
): Promise<void> {
  await query(
    `INSERT INTO binary_selector_decisions(
       opportunity_id, selector_version, selector_state, recommended_model, authoritative_model,
       recommendation_only, fallback_used, reason, evidence_scope, sample_size, estimate, ci_low, ci_high,
       regime_snapshot, baseline_prediction_id, logistic_prediction_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
     ON CONFLICT (opportunity_id) DO UPDATE SET
       selector_version=EXCLUDED.selector_version,
       selector_state=EXCLUDED.selector_state,
       recommended_model=EXCLUDED.recommended_model,
       authoritative_model=EXCLUDED.authoritative_model,
       recommendation_only=EXCLUDED.recommendation_only,
       fallback_used=EXCLUDED.fallback_used,
       reason=EXCLUDED.reason,
       evidence_scope=EXCLUDED.evidence_scope,
       sample_size=EXCLUDED.sample_size,
       estimate=EXCLUDED.estimate,
       ci_low=EXCLUDED.ci_low,
       ci_high=EXCLUDED.ci_high,
       regime_snapshot=EXCLUDED.regime_snapshot,
       baseline_prediction_id=COALESCE(EXCLUDED.baseline_prediction_id, binary_selector_decisions.baseline_prediction_id),
       logistic_prediction_id=COALESCE(EXCLUDED.logistic_prediction_id, binary_selector_decisions.logistic_prediction_id),
       updated_at=now()`,
    [
      opportunityId,
      decision.selectorVersion,
      decision.state,
      decision.recommendedModel,
      decision.authoritativeModel,
      decision.recommendationOnly,
      decision.fallbackUsed,
      decision.reason,
      decision.evidence.scope,
      decision.evidence.sampleSize,
      decision.evidence.estimate,
      decision.evidence.ciLow,
      decision.evidence.ciHigh,
      JSON.stringify(decision.regime),
      baselinePredictionId,
      logisticPredictionId,
    ],
  );
}

/** Mark selector decisions resolved once sibling predictions have outcomes. */
export async function resolveSelectorDecisions(): Promise<number> {
  const pending = await query<{
    opportunity_id: string;
    recommended_model: string;
    authoritative_model: string;
    baseline_prediction_id: string | null;
    logistic_prediction_id: string | null;
  }>(
    `SELECT sd.opportunity_id, sd.recommended_model, sd.authoritative_model,
            sd.baseline_prediction_id, sd.logistic_prediction_id
     FROM binary_selector_decisions sd
     WHERE sd.resolved_at IS NULL
       AND sd.baseline_prediction_id IS NOT NULL`,
  );

  let resolved = 0;
  for (const row of pending.rows) {
    const predictions = await query<{ id: string; model_name: string; result: string | null; status: string }>(
      `SELECT id, model_name, result, status
       FROM binary_predictions
       WHERE opportunity_id=$1 AND status='resolved' AND result IS NOT NULL`,
      [row.opportunity_id],
    );
    const baseline = predictions.rows.find((p) => p.model_name === BINARY_MODEL_NAME);
    const logistic = predictions.rows.find((p) => p.model_name === BINARY_LOGISTIC_MODEL_NAME);
    if (!baseline) continue;
    if (row.logistic_prediction_id && !logistic) continue;

    const recommended = row.recommended_model === BINARY_LOGISTIC_MODEL_NAME ? logistic : baseline;
    const authoritative = row.authoritative_model === BINARY_LOGISTIC_MODEL_NAME ? logistic : baseline;
    const recommendedCorrect = recommended?.result === "won" ? true : recommended?.result === "lost" ? false : null;
    const authoritativeCorrect = authoritative?.result === "won" ? true : authoritative?.result === "lost" ? false : null;
    const baselineCorrect = baseline.result === "won" ? true : baseline.result === "lost" ? false : null;
    const logisticCorrect = logistic?.result === "won" ? true : logistic?.result === "lost" ? false : null;

    await query(
      `UPDATE binary_selector_decisions
       SET resolved_at=now(),
           recommended_model_correct=$2,
           authoritative_model_correct=$3,
           baseline_correct=$4,
           logistic_correct=$5,
           updated_at=now()
       WHERE opportunity_id=$1 AND resolved_at IS NULL`,
      [row.opportunity_id, recommendedCorrect, authoritativeCorrect, baselineCorrect, logisticCorrect],
    );
    resolved += 1;
  }
  return resolved;
}

export async function binaryAdaptiveSelectorStatus(): Promise<SelectorStatus> {
  return buildSelectorStatus();
}
