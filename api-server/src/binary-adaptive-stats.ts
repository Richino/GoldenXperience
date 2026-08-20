import { query } from "./database.js";
import {
  BINARY_MULTI_REGIME_KEYS,
  BINARY_ROLLING_WINDOWS,
  deriveRegimeDescriptor,
  evidenceLabel,
  loadBinaryRegimeConfig,
  wilsonInterval,
  type BinaryRegimeDescriptor,
  type BinaryRollingWindow,
  type EvidenceLabel,
  type RegimeLabel,
  type TrendRegimeLabel,
} from "./binary-regimes.js";
import { BINARY_MODEL_NAME } from "./binary-engine.js";
import { BINARY_LOGISTIC_MODEL_NAME } from "./binary-logistic-v1.js";

export type AdaptivePredictionRow = {
  id: string;
  modelName: string;
  modelVersion: string;
  instrument: string;
  direction: "up" | "down";
  status: string;
  result: "won" | "lost" | "tie" | null;
  confidence: number;
  scoreKind: "heuristic_score" | "probability";
  features: Record<string, unknown>;
  marketContext: Record<string, unknown>;
  opportunityId: string | null;
  isShadow: boolean;
  startAt: string;
  entryPrice: number | null;
  resolutionPrice: number | null;
  spreadPips: number | null;
  regime: BinaryRegimeDescriptor;
};

export type ModelStatBlock = {
  modelName: string;
  modelVersion: string;
  scoreKind: "heuristic_score" | "probability";
  total: number;
  active: number;
  resolved: number;
  won: number;
  lost: number;
  tie: number;
  voids: number;
  decided: number;
  winRate: number | null;
  lossRate: number | null;
  tieRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  sampleSize: number;
  evidence: EvidenceLabel;
  avgConfidence: number | null;
  avgAbsMovePips: number | null;
  avgSpreadPips: number | null;
};

export type GroupedModelStat = ModelStatBlock & {
  group: string;
  groupKey: string;
  dimensions: Record<string, string>;
};

export type HeadToHeadStats = {
  sharedResolvedOpportunities: number;
  agreementCount: number;
  disagreementCount: number;
  agreementRate: number | null;
  baselineOnlyCorrect: number;
  logisticOnlyCorrect: number;
  bothCorrect: number;
  bothWrong: number;
  baselineTie: number;
  logisticTie: number;
  logisticDisagreementWinRate: number | null;
  logisticDisagreementWinRateCiLow: number | null;
  logisticDisagreementWinRateCiHigh: number | null;
  evidence: EvidenceLabel;
  byRegime: Array<{
    groupKey: string;
    dimensions: Record<string, string>;
    disagreementCount: number;
    baselineOnlyCorrect: number;
    logisticOnlyCorrect: number;
    logisticDisagreementWinRate: number | null;
    evidence: EvidenceLabel;
  }>;
};

export type RollingModelStat = {
  window: BinaryRollingWindow;
  models: ModelStatBlock[];
};

export type BinaryAdaptiveStats = {
  regimeConfigVersion: string;
  generatedAt: string;
  models: ModelStatBlock[];
  byInstrument: GroupedModelStat[];
  bySession: GroupedModelStat[];
  byAtrRegime: GroupedModelStat[];
  byVolatilityRegime: GroupedModelStat[];
  byTrendRegime: GroupedModelStat[];
  byConfidence: GroupedModelStat[];
  byMultiRegime: GroupedModelStat[];
  headToHead: HeadToHeadStats;
  rolling: RollingModelStat[];
};

type RawPredictionRow = {
  id: string;
  model_name: string;
  model_version: string;
  instrument: string;
  direction: "up" | "down";
  status: string;
  result: "won" | "lost" | "tie" | null;
  confidence: string;
  score_kind: "heuristic_score" | "probability";
  features: Record<string, unknown>;
  market_context: Record<string, unknown>;
  opportunity_id: string | null;
  is_shadow: boolean;
  start_at: string | Date;
  entry_price: string | null;
  resolution_price: string | null;
};

function pipSizeApprox(instrument: string) {
  return instrument.includes("JPY") ? 0.01 : 0.0001;
}

function normalizeRow(row: RawPredictionRow): AdaptivePredictionRow {
  const features = row.features ?? {};
  const marketContext = row.market_context ?? {};
  const confidence = Number(row.confidence);
  const scoreKind = row.score_kind;
  return {
    id: row.id,
    modelName: row.model_name,
    modelVersion: row.model_version,
    instrument: row.instrument,
    direction: row.direction,
    status: row.status,
    result: row.result,
    confidence,
    scoreKind,
    features,
    marketContext,
    opportunityId: row.opportunity_id,
    isShadow: row.is_shadow,
    startAt: new Date(row.start_at).toISOString(),
    entryPrice: row.entry_price == null ? null : Number(row.entry_price),
    resolutionPrice: row.resolution_price == null ? null : Number(row.resolution_price),
    spreadPips: typeof features.spreadPips === "number" ? features.spreadPips : null,
    regime: deriveRegimeDescriptor({
      instrument: row.instrument,
      features,
      marketContext,
      confidence,
      scoreKind,
    }),
  };
}

function aggregateRows(rows: AdaptivePredictionRow[]): Omit<ModelStatBlock, "modelName" | "modelVersion" | "scoreKind"> {
  const resolved = rows.filter((row) => row.status === "resolved" && row.result != null);
  const won = resolved.filter((row) => row.result === "won").length;
  const lost = resolved.filter((row) => row.result === "lost").length;
  const tie = resolved.filter((row) => row.result === "tie").length;
  const voids = rows.filter((row) => row.status === "error").length;
  const decided = won + lost;
  const { ciLow, ciHigh } = wilsonInterval(won, decided);
  const confidences = resolved.map((row) => row.confidence).filter(Number.isFinite);
  const moves = resolved
    .filter((row) => row.entryPrice != null && row.resolutionPrice != null)
    .map((row) => Math.abs(row.resolutionPrice! - row.entryPrice!) / pipSizeApprox(row.instrument));
  const spreads = resolved.map((row) => row.spreadPips).filter((value): value is number => value != null && Number.isFinite(value));

  return {
    total: rows.length,
    active: rows.filter((row) => row.status === "active").length,
    resolved: resolved.length,
    won,
    lost,
    tie,
    voids,
    decided,
    winRate: decided > 0 ? won / decided : null,
    lossRate: decided > 0 ? lost / decided : null,
    tieRate: resolved.length > 0 ? tie / resolved.length : null,
    ciLow,
    ciHigh,
    sampleSize: decided,
    evidence: evidenceLabel(decided),
    avgConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
    avgAbsMovePips: moves.length ? moves.reduce((sum, value) => sum + value, 0) / moves.length : null,
    avgSpreadPips: spreads.length ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length : null,
  };
}

function modelBlock(rows: AdaptivePredictionRow[]): ModelStatBlock {
  const first = rows[0];
  return {
    modelName: first?.modelName ?? "unknown",
    modelVersion: first?.modelVersion ?? "unknown",
    scoreKind: first?.scoreKind ?? "heuristic_score",
    ...aggregateRows(rows),
  };
}

function groupedStats(
  rows: AdaptivePredictionRow[],
  keyFor: (row: AdaptivePredictionRow) => { group: string; groupKey: string; dimensions: Record<string, string> },
): GroupedModelStat[] {
  const byModel = new Map<string, AdaptivePredictionRow[]>();
  for (const row of rows) {
    const modelKey = `${row.modelName}|${row.modelVersion}`;
    byModel.set(modelKey, [...(byModel.get(modelKey) ?? []), row]);
  }

  const results: GroupedModelStat[] = [];
  for (const modelRows of byModel.values()) {
    const groups = new Map<string, { meta: ReturnType<typeof keyFor>; rows: AdaptivePredictionRow[] }>();
    for (const row of modelRows) {
      const meta = keyFor(row);
      const bucketKey = `${meta.groupKey}`;
      const existing = groups.get(bucketKey);
      if (existing) existing.rows.push(row);
      else groups.set(bucketKey, { meta, rows: [row] });
    }
    for (const { meta, rows: groupRows } of groups.values()) {
      results.push({
        group: meta.group,
        groupKey: meta.groupKey,
        dimensions: meta.dimensions,
        ...modelBlock(groupRows),
      });
    }
  }

  return results.sort((a, b) => b.decided - a.decided || a.group.localeCompare(b.group));
}

function multiRegimeKey(row: AdaptivePredictionRow, template: string) {
  const parts = template.split("|");
  const dimensions: Record<string, string> = {};
  for (const part of parts) {
    switch (part) {
      case "instrument":
        dimensions.instrument = row.instrument;
        break;
      case "session":
        dimensions.session = row.regime.session;
        break;
      case "atrRegime":
        dimensions.atrRegime = row.regime.atrRegime;
        break;
      case "volatilityRegime":
        dimensions.volatilityRegime = row.regime.volatilityRegime;
        break;
      case "trendRegime":
        dimensions.trendRegime = row.regime.trendRegime;
        break;
      default: {
        const _exhaustive: never = part as never;
        throw new Error(`Unknown multi-regime dimension: ${_exhaustive}`);
      }
    }
  }
  const groupKey = parts.map((part) => `${part}:${dimensions[part] ?? "unknown"}`).join("|");
  return { group: template, groupKey, dimensions };
}

export function buildHeadToHeadStats(rows: AdaptivePredictionRow[]): HeadToHeadStats {
  const baselineByOpportunity = new Map<string, AdaptivePredictionRow>();
  const logisticByOpportunity = new Map<string, AdaptivePredictionRow>();

  for (const row of rows) {
    if (!row.opportunityId || row.status !== "resolved" || row.result == null) continue;
    if (row.modelName === BINARY_MODEL_NAME && !row.isShadow) baselineByOpportunity.set(row.opportunityId, row);
    if (row.modelName === BINARY_LOGISTIC_MODEL_NAME || row.isShadow) logisticByOpportunity.set(row.opportunityId, row);
  }

  let agreementCount = 0;
  let disagreementCount = 0;
  let baselineOnlyCorrect = 0;
  let logisticOnlyCorrect = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  let baselineTie = 0;
  let logisticTie = 0;

  const regimeDisagreements = new Map<string, {
    dimensions: Record<string, string>;
    disagreementCount: number;
    baselineOnlyCorrect: number;
    logisticOnlyCorrect: number;
  }>();

  for (const [opportunityId, baseline] of baselineByOpportunity) {
    const logistic = logisticByOpportunity.get(opportunityId);
    if (!logistic) continue;

    const sameDirection = baseline.direction === logistic.direction;
    if (sameDirection) agreementCount += 1;
    else disagreementCount += 1;

    const baselineWon = baseline.result === "won";
    const logisticWon = logistic.result === "won";
    const baselineLost = baseline.result === "lost";
    const logisticLost = logistic.result === "lost";

    if (baseline.result === "tie") baselineTie += 1;
    if (logistic.result === "tie") logisticTie += 1;

    if (baselineWon && logisticWon) bothCorrect += 1;
    else if (baselineLost && logisticLost) bothWrong += 1;
    else if (baselineWon && logisticLost) baselineOnlyCorrect += 1;
    else if (logisticWon && baselineLost) logisticOnlyCorrect += 1;

    if (!sameDirection) {
      const key = `atrRegime:${baseline.regime.atrRegime}|volatilityRegime:${baseline.regime.volatilityRegime}`;
      const bucket = regimeDisagreements.get(key) ?? {
        dimensions: {
          atrRegime: baseline.regime.atrRegime,
          volatilityRegime: baseline.regime.volatilityRegime,
        },
        disagreementCount: 0,
        baselineOnlyCorrect: 0,
        logisticOnlyCorrect: 0,
      };
      bucket.disagreementCount += 1;
      if (baselineWon && logisticLost) bucket.baselineOnlyCorrect += 1;
      if (logisticWon && baselineLost) bucket.logisticOnlyCorrect += 1;
      regimeDisagreements.set(key, bucket);
    }
  }

  const sharedResolvedOpportunities = [...baselineByOpportunity.keys()].filter((id) => logisticByOpportunity.has(id)).length;
  const decidedDisagreements = baselineOnlyCorrect + logisticOnlyCorrect;
  const { ciLow, ciHigh } = wilsonInterval(logisticOnlyCorrect, decidedDisagreements);

  return {
    sharedResolvedOpportunities,
    agreementCount,
    disagreementCount,
    agreementRate: sharedResolvedOpportunities > 0 ? agreementCount / sharedResolvedOpportunities : null,
    baselineOnlyCorrect,
    logisticOnlyCorrect,
    bothCorrect,
    bothWrong,
    baselineTie,
    logisticTie,
    logisticDisagreementWinRate: decidedDisagreements > 0 ? logisticOnlyCorrect / decidedDisagreements : null,
    logisticDisagreementWinRateCiLow: ciLow,
    logisticDisagreementWinRateCiHigh: ciHigh,
    evidence: evidenceLabel(decidedDisagreements),
    byRegime: [...regimeDisagreements.values()]
      .map((bucket) => {
        const decided = bucket.baselineOnlyCorrect + bucket.logisticOnlyCorrect;
        return {
          groupKey: `atrRegime:${bucket.dimensions.atrRegime}|volatilityRegime:${bucket.dimensions.volatilityRegime}`,
          dimensions: bucket.dimensions,
          disagreementCount: bucket.disagreementCount,
          baselineOnlyCorrect: bucket.baselineOnlyCorrect,
          logisticOnlyCorrect: bucket.logisticOnlyCorrect,
          logisticDisagreementWinRate: decided > 0 ? bucket.logisticOnlyCorrect / decided : null,
          evidence: evidenceLabel(decided),
        };
      })
      .sort((a, b) => b.disagreementCount - a.disagreementCount),
  };
}

export function buildRollingModelStats(rows: AdaptivePredictionRow[]): RollingModelStat[] {
  const byModel = new Map<string, AdaptivePredictionRow[]>();
  for (const row of rows.filter((item) => item.status === "resolved")) {
    const key = `${row.modelName}|${row.modelVersion}`;
    byModel.set(key, [...(byModel.get(key) ?? []), row]);
  }

  const windows: BinaryRollingWindow[] = [...BINARY_ROLLING_WINDOWS, "all"];
  return windows.map((window) => ({
    window,
    models: [...byModel.entries()].map(([_, modelRows]) => {
      const chronological = [...modelRows].sort((a, b) => a.startAt.localeCompare(b.startAt));
      const slice = window === "all" ? chronological : chronological.slice(-window);
      return modelBlock(slice);
    }).sort((a, b) => a.modelName.localeCompare(b.modelName)),
  }));
}

export function buildBinaryAdaptiveStats(rows: AdaptivePredictionRow[]): BinaryAdaptiveStats {
  const config = loadBinaryRegimeConfig();
  const byModel = new Map<string, AdaptivePredictionRow[]>();
  for (const row of rows) {
    const key = `${row.modelName}|${row.modelVersion}`;
    byModel.set(key, [...(byModel.get(key) ?? []), row]);
  }

  const multiRegime: GroupedModelStat[] = [];
  for (const template of BINARY_MULTI_REGIME_KEYS) {
    multiRegime.push(...groupedStats(rows, (row) => multiRegimeKey(row, template)));
  }

  return {
    regimeConfigVersion: config.version,
    generatedAt: new Date().toISOString(),
    models: [...byModel.values()].map(modelBlock).sort((a, b) => a.modelName.localeCompare(b.modelName)),
    byInstrument: groupedStats(rows, (row) => ({
      group: row.instrument,
      groupKey: row.instrument,
      dimensions: { instrument: row.instrument },
    })),
    bySession: groupedStats(rows, (row) => ({
      group: row.regime.session,
      groupKey: row.regime.session,
      dimensions: { session: row.regime.session },
    })),
    byAtrRegime: groupedStats(rows, (row) => ({
      group: row.regime.atrRegime,
      groupKey: row.regime.atrRegime,
      dimensions: { atrRegime: row.regime.atrRegime },
    })),
    byVolatilityRegime: groupedStats(rows, (row) => ({
      group: row.regime.volatilityRegime,
      groupKey: row.regime.volatilityRegime,
      dimensions: { volatilityRegime: row.regime.volatilityRegime },
    })),
    byTrendRegime: groupedStats(rows, (row) => ({
      group: row.regime.trendRegime,
      groupKey: row.regime.trendRegime,
      dimensions: { trendRegime: row.regime.trendRegime },
    })),
    byConfidence: groupedStats(rows, (row) => ({
      group: row.regime.confidenceBucket,
      groupKey: `${row.scoreKind}:${row.regime.confidenceBucket}`,
      dimensions: { scoreKind: row.scoreKind, confidenceBucket: row.regime.confidenceBucket },
    })),
    byMultiRegime: multiRegime.sort((a, b) => b.decided - a.decided),
    headToHead: buildHeadToHeadStats(rows),
    rolling: buildRollingModelStats(rows),
  };
}

/** Load all resolved/active predictions for adaptive memory (includes shadow rows). */
export async function loadAdaptivePredictionRows(): Promise<AdaptivePredictionRow[]> {
  const result = await query<RawPredictionRow>(
    `SELECT id, model_name, model_version, instrument, direction, status, result,
            confidence::float AS confidence, score_kind, features, market_context,
            opportunity_id, is_shadow, start_at, entry_price::float AS entry_price,
            resolution_price::float AS resolution_price
     FROM binary_predictions
     ORDER BY start_at ASC`,
  );
  return result.rows.map(normalizeRow);
}

export async function binaryAdaptiveStats(): Promise<BinaryAdaptiveStats> {
  const rows = await loadAdaptivePredictionRows();
  return buildBinaryAdaptiveStats(rows);
}

/** Prove baseline-only stats ignore shadow inflation. */
export async function loadBaselineAdaptiveRows(): Promise<AdaptivePredictionRow[]> {
  const rows = await loadAdaptivePredictionRows();
  return rows.filter((row) => !row.isShadow && row.modelName === BINARY_MODEL_NAME);
}

export function buildBaselineOnlyAdaptiveStats(rows: AdaptivePredictionRow[]): BinaryAdaptiveStats {
  return buildBinaryAdaptiveStats(rows.filter((row) => !row.isShadow && row.modelName === BINARY_MODEL_NAME));
}

export type RegimeDimensionKey = "atrRegime" | "volatilityRegime" | "trendRegime";

export function filterRowsByRegime(
  rows: AdaptivePredictionRow[],
  filters: Partial<Record<RegimeDimensionKey, RegimeLabel | TrendRegimeLabel>>,
) {
  return rows.filter((row) =>
    (filters.atrRegime == null || row.regime.atrRegime === filters.atrRegime)
    && (filters.volatilityRegime == null || row.regime.volatilityRegime === filters.volatilityRegime)
    && (filters.trendRegime == null || row.regime.trendRegime === filters.trendRegime),
  );
}

export type PairedOpportunity = {
  opportunityId: string;
  baseline: AdaptivePredictionRow;
  logistic: AdaptivePredictionRow;
};

export type PairedDisagreementEvidence = {
  scope: string;
  dimensions: Record<string, string>;
  baselineOnlyCorrect: number;
  logisticOnlyCorrect: number;
  disagreementCount: number;
  chronologicalPairs: PairedOpportunity[];
};

function dimensionsMatch(row: AdaptivePredictionRow, dimensions: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(dimensions)) {
    switch (key) {
      case "instrument":
        if (row.instrument !== value) return false;
        break;
      case "session":
        if (row.regime.session !== value) return false;
        break;
      case "atrRegime":
        if (row.regime.atrRegime !== value) return false;
        break;
      case "volatilityRegime":
        if (row.regime.volatilityRegime !== value) return false;
        break;
      case "trendRegime":
        if (row.regime.trendRegime !== value) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function pairResolvedRows(rows: AdaptivePredictionRow[]): PairedOpportunity[] {
  const baselineByOpportunity = new Map<string, AdaptivePredictionRow>();
  const logisticByOpportunity = new Map<string, AdaptivePredictionRow>();
  for (const row of rows) {
    if (!row.opportunityId || row.status !== "resolved" || row.result == null) continue;
    if (row.modelName === BINARY_MODEL_NAME && !row.isShadow) baselineByOpportunity.set(row.opportunityId, row);
    if (row.modelName === BINARY_LOGISTIC_MODEL_NAME || row.isShadow) logisticByOpportunity.set(row.opportunityId, row);
  }
  const pairs: PairedOpportunity[] = [];
  for (const [opportunityId, baseline] of baselineByOpportunity) {
    const logistic = logisticByOpportunity.get(opportunityId);
    if (!logistic) continue;
    pairs.push({ opportunityId, baseline, logistic });
  }
  return pairs.sort((a, b) => a.baseline.startAt.localeCompare(b.baseline.startAt));
}

/** Paired disagreement counts for selector evidence scopes. */
export function buildPairedDisagreementEvidence(
  rows: AdaptivePredictionRow[],
  scope: string,
  dimensions: Record<string, string> = {},
): PairedDisagreementEvidence {
  const pairs = pairResolvedRows(rows).filter((pair) => dimensionsMatch(pair.baseline, dimensions));
  let baselineOnlyCorrect = 0;
  let logisticOnlyCorrect = 0;
  let disagreementCount = 0;

  for (const pair of pairs) {
    if (pair.baseline.direction === pair.logistic.direction) continue;
    disagreementCount += 1;
    const baselineWon = pair.baseline.result === "won";
    const logisticWon = pair.logistic.result === "won";
    const baselineLost = pair.baseline.result === "lost";
    const logisticLost = pair.logistic.result === "lost";
    if (baselineWon && logisticLost) baselineOnlyCorrect += 1;
    else if (logisticWon && baselineLost) logisticOnlyCorrect += 1;
  }

  return {
    scope,
    dimensions,
    baselineOnlyCorrect,
    logisticOnlyCorrect,
    disagreementCount,
    chronologicalPairs: pairs,
  };
}

export type SelectorSelfEvaluation = {
  resolvedDecisions: number;
  recommendationCorrect: number;
  recommendationAccuracy: number | null;
  authoritativeCorrect: number;
  authoritativeAccuracy: number | null;
  accuracyDifference: number | null;
  evidence: EvidenceLabel;
};

/** Evaluate how the selector recommendations would have performed on resolved paired opportunities. */
export function buildSelectorSelfEvaluation(rows: AdaptivePredictionRow[]): SelectorSelfEvaluation {
  const pairs = pairResolvedRows(rows);
  let recommendationCorrect = 0;
  let authoritativeCorrect = 0;
  let decided = 0;

  for (const pair of pairs) {
    if (pair.baseline.result === "tie" || pair.logistic.result === "tie") continue;
    decided += 1;
    const baselineWon = pair.baseline.result === "won";
    const logisticWon = pair.logistic.result === "won";
    if (baselineWon) authoritativeCorrect += 1;

    // Shadow recommendation: whichever model won the disagreement when directions differ,
    // otherwise whichever model won outright.
    if (pair.baseline.direction !== pair.logistic.direction) {
      if (baselineWon && !logisticWon) recommendationCorrect += 1;
      else if (logisticWon && !baselineWon) recommendationCorrect += 1;
    } else if (baselineWon) {
      recommendationCorrect += 1;
    }
  }

  return {
    resolvedDecisions: decided,
    recommendationCorrect,
    recommendationAccuracy: decided > 0 ? recommendationCorrect / decided : null,
    authoritativeCorrect,
    authoritativeAccuracy: decided > 0 ? authoritativeCorrect / decided : null,
    accuracyDifference: decided > 0 ? (recommendationCorrect - authoritativeCorrect) / decided : null,
    evidence: evidenceLabel(decided),
  };
}
