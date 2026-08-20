import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BinaryFeatures } from "./binary-engine.js";

export type RegimeLabel = "LOW" | "NORMAL" | "HIGH";
export type TrendRegimeLabel = "DOWN" | "FLAT" | "UP";
export type EvidenceLabel = "INSUFFICIENT" | "EARLY" | "USABLE" | "STRONG";

export type BinaryRegimeConfig = {
  version: string;
  generatedAt: string;
  sampleSize: number;
  method: string;
  sessions: { known: string[]; fallback: string };
  atrPips: { labels: RegimeLabel[]; lowUpper: number; highLower: number };
  volatilityPips: { labels: RegimeLabel[]; lowUpper: number; highLower: number };
  trend: { labels: TrendRegimeLabel[]; downUpper: number; upLower: number; note: string };
  confidenceBuckets: {
    heuristic_score: ConfidenceBucketDef[];
    probability: ConfidenceBucketDef[];
  };
};

type ConfidenceBucketDef = {
  label: string;
  min: number;
  max: number | null;
  maxInclusive: boolean;
};

export type BinaryRegimeDescriptor = {
  instrument: string;
  session: string;
  atrRegime: RegimeLabel;
  volatilityRegime: RegimeLabel;
  trendRegime: TrendRegimeLabel;
  confidenceBucket: string;
  scoreKind: "heuristic_score" | "probability";
};

/** Centralized evidence thresholds for adaptive memory (informational in Phase 2). */
export const BINARY_EVIDENCE_THRESHOLDS = {
  insufficientBelow: 30,
  earlyBelow: 100,
  usableBelow: 300,
} as const;

export function evidenceLabel(sampleSize: number): EvidenceLabel {
  if (sampleSize < BINARY_EVIDENCE_THRESHOLDS.insufficientBelow) return "INSUFFICIENT";
  if (sampleSize < BINARY_EVIDENCE_THRESHOLDS.earlyBelow) return "EARLY";
  if (sampleSize < BINARY_EVIDENCE_THRESHOLDS.usableBelow) return "USABLE";
  return "STRONG";
}

let cachedConfig: BinaryRegimeConfig | null = null;

export function loadBinaryRegimeConfig(customPath?: string): BinaryRegimeConfig {
  if (cachedConfig && !customPath) return cachedConfig;
  const configPath = customPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "binary-regimes-v1.json");
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as BinaryRegimeConfig;
  if (!customPath) cachedConfig = parsed;
  return parsed;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function emaGapPctFromFeatures(features: BinaryFeatures | Record<string, unknown>): number | null {
  const emaFast = num((features as BinaryFeatures).emaFast);
  const emaSlow = num((features as BinaryFeatures).emaSlow);
  const referenceClose = num((features as BinaryFeatures).referenceClose) ?? (features as { referenceClose?: number }).referenceClose;
  if (emaFast == null || emaSlow == null || !referenceClose) return null;
  return (emaFast - emaSlow) / referenceClose;
}

export function classifyAtrRegime(atrPips: number | null, config = loadBinaryRegimeConfig()): RegimeLabel {
  if (atrPips == null) return "NORMAL";
  if (atrPips <= config.atrPips.lowUpper) return "LOW";
  if (atrPips >= config.atrPips.highLower) return "HIGH";
  return "NORMAL";
}

export function classifyVolatilityRegime(volatilityPips: number | null, config = loadBinaryRegimeConfig()): RegimeLabel {
  if (volatilityPips == null) return "NORMAL";
  if (volatilityPips <= config.volatilityPips.lowUpper) return "LOW";
  if (volatilityPips >= config.volatilityPips.highLower) return "HIGH";
  return "NORMAL";
}

export function classifyTrendRegime(emaGapPct: number | null, config = loadBinaryRegimeConfig()): TrendRegimeLabel {
  if (emaGapPct == null) return "FLAT";
  if (emaGapPct <= config.trend.downUpper) return "DOWN";
  if (emaGapPct >= config.trend.upLower) return "UP";
  return "FLAT";
}

export function classifySessionLabel(session: string | null | undefined, config = loadBinaryRegimeConfig()): string {
  if (!session) return config.sessions.fallback;
  return config.sessions.known.includes(session) ? session : config.sessions.fallback;
}

export function classifyConfidenceBucket(
  confidence: number,
  scoreKind: "heuristic_score" | "probability",
  config = loadBinaryRegimeConfig(),
): string {
  const buckets = config.confidenceBuckets[scoreKind];
  for (const bucket of buckets) {
    const aboveMin = confidence >= bucket.min;
    const belowMax = bucket.max == null
      ? true
      : bucket.maxInclusive ? confidence <= bucket.max : confidence < bucket.max;
    if (aboveMin && belowMax) return bucket.label;
  }
  return "unknown";
}

export function deriveRegimeDescriptor(input: {
  instrument: string;
  features: BinaryFeatures | Record<string, unknown>;
  marketContext?: Record<string, unknown> | null;
  confidence: number;
  scoreKind: "heuristic_score" | "probability";
}, config = loadBinaryRegimeConfig()): BinaryRegimeDescriptor {
  const features = input.features as BinaryFeatures;
  const session = classifySessionLabel(
    (input.marketContext?.session as string | undefined) ?? features.session,
    config,
  );
  return {
    instrument: input.instrument,
    session,
    atrRegime: classifyAtrRegime(num(features.atrPips), config),
    volatilityRegime: classifyVolatilityRegime(num(features.volatilityPips), config),
    trendRegime: classifyTrendRegime(emaGapPctFromFeatures(features), config),
    confidenceBucket: classifyConfidenceBucket(input.confidence, input.scoreKind, config),
    scoreKind: input.scoreKind,
  };
}

/** Wilson 95% interval for binomial proportion (wins / decided). */
export function wilsonInterval(wins: number, decided: number, z = 1.96): { ciLow: number | null; ciHigh: number | null } {
  if (decided <= 0) return { ciLow: null, ciHigh: null };
  const p = wins / decided;
  const denominator = 1 + (z * z) / decided;
  const center = p + (z * z) / (2 * decided);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * decided)) / decided);
  return { ciLow: (center - margin) / denominator, ciHigh: (center + margin) / denominator };
}

export const BINARY_ROLLING_WINDOWS = [50, 100, 250] as const;
export type BinaryRollingWindow = (typeof BINARY_ROLLING_WINDOWS)[number] | "all";

export const BINARY_MULTI_REGIME_KEYS = [
  "instrument|session",
  "atrRegime|volatilityRegime",
  "trendRegime|volatilityRegime",
  "instrument|atrRegime",
  "instrument|session|atrRegime",
] as const;
