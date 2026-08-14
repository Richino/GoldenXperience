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
