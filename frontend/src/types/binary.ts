/**
 * Binary Prediction records, as returned by the api-server `/api/binary/*`
 * endpoints. These mirror the immutable audit rows in `binary_predictions`:
 * predictions are created and resolved server-side and are read-only here.
 */

export type BinaryDirection = "up" | "down";
export type BinaryResult = "won" | "lost" | "tie";
export type BinaryStatus = "active" | "resolved" | "error";

export interface BinaryPrediction {
  id: string;
  sequence: string;
  instrument: string;
  direction: BinaryDirection;
  status: BinaryStatus;
  modelName: string;
  modelVersion: string;
  createdAt: string;
  startAt: string;
  entryPrice: number;
  durationSeconds: number;
  intendedExpiration: string;
  resolutionPrice: number | null;
  resolutionPriceTime: string | null;
  resolutionSource: "m1_candle" | "live_tick" | null;
  resolvedAt: string | null;
  result: BinaryResult | null;
  confidence: number;
  scoreKind: string;
  pricePrecision: number;
  /** Experiment that produced the row; null for the baseline engine. */
  strategySource: string | null;
  /** Pattern V1 branch, when this row came from Pattern V1. */
  patternBranch: string | null;
}

/** Forward status for the frozen Pattern V1 experiment. */
export interface PatternV1Forward {
  strategy: string;
  version: string;
  source: string;
  configHash: string;
  configVerified: boolean | null;
  startedAt: string | null;
  total: number;
  pending: number;
  resolved: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
  ev80: number | null;
  nextCheckpoint: number | null;
  branches: Array<{ branch: string; n: number; wins: number; losses: number; ties: number; winRate: number | null }>;
}

export interface BinaryPredictionDetail extends BinaryPrediction {
  features: Record<string, unknown>;
  marketContext: Record<string, unknown>;
  secondaryMarks: Record<string, { price: number; priceTime: string; result: BinaryResult }>;
  errorReason: string | null;
}

export interface BinaryWatchRow {
  instrument: string;
  modelName: string;
  modelVersion: string;
  evaluatedAt: string | null;
  dataStatus: "connected" | "unavailable" | "stale";
  bias: BinaryDirection | "wait" | null;
  score: number | null;
  scoreKind: string;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  session: string;
  activePredictionId: string | null;
  activeDirection: BinaryDirection | null;
  activeEntry: number | null;
  activeStartAt: string | null;
  activeExpiration: string | null;
  updatedAt: string | null;
}

export interface BinaryStatsGroup {
  group: string;
  total: number;
  active: number;
  resolved: number;
  won: number;
  lost: number;
  tie: number;
  winRate: number | null;
  evidenceEligible: boolean;
}

export interface BinaryHorizonBreakdown {
  horizonSeconds: number;
  label: string;
  resolved: number;
  won: number;
  lost: number;
  tie: number;
  /** Predictions whose price at this horizon was never captured (e.g. an M1 gap). */
  missing: number;
  winRate: number | null;
  evidenceEligible: boolean;
}

export interface BinaryPerformance {
  model: { name: string; version: string; scoreKind: string };
  summary: Omit<BinaryStatsGroup, "group">;
  breakdowns: {
    symbol: BinaryStatsGroup[];
    direction: BinaryStatsGroup[];
    session: BinaryStatsGroup[];
    timeOfDay: BinaryStatsGroup[];
    score: BinaryStatsGroup[];
    model: BinaryStatsGroup[];
  };
  /** Win rate at 5m / 10m / 15m over the same resolved predictions. */
  horizons: BinaryHorizonBreakdown[];
}
