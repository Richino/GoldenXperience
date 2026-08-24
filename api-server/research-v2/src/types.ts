/**
 * GoldenXperience V2 — shared types.
 * Research only. Never imported by live paper-cycle / adaptive allowlist.
 */

export type Direction = "long" | "short";
export type Decision = Direction | "wait";

export type HorizonId = "15m" | "30m" | "1h" | "2h" | "4h" | "1d";

export type ModelKind = "ridge" | "logistic" | "boost_reg" | "boost_clf";

export type FeatureFamily =
  | "price"
  | "cross_pair"
  | "regime"
  | "session"
  | "macro"
  | "events";

export type Candle = {
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Quote = {
  closeTime: string;
  bidOpen: number;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askOpen: number;
  askHigh: number;
  askLow: number;
  askClose: number;
};

export type DataZones = {
  trainStart: string;
  trainEnd: string;
  devStart: string;
  devEnd: string;
  sealedStart: string;
  sealedEnd: string;
};

export type RegimeSnapshot = {
  trend: "bull" | "bear" | "range" | "mixed";
  volBucket: "low" | "normal" | "high";
  volPhase: "compression" | "normal" | "expansion";
  session: "asia" | "london" | "newyork" | "overlap" | "off";
  eventWindow: "none" | "pre" | "major" | "post";
  trendStrength: number;
  slopeAtr: number;
  atr: number;
  rangeWidthAtr: number;
};

export type ForwardLabel = {
  horizon: HorizonId;
  bars: number;
  rawReturn: number;
  atrReturn: number;
  mfe: number;
  mae: number;
  spreadCost: number;
  slippageCost: number;
  netReturn: number;
  directionHit: 0 | 1 | null;
};

export type Sample = {
  instrument: string;
  timeframe: string;
  closeTime: string;
  ts: number;
  midClose: number;
  bidClose: number;
  askClose: number;
  spread: number;
  atr: number;
  features: Record<string, number>;
  regime: RegimeSnapshot;
  labels: Partial<Record<HorizonId, ForwardLabel>>;
};

export type Prediction = {
  decision: Decision;
  expectedNetReturn: number;
  probabilityAdvantage: number;
  confidence: number;
  modelAgreement: number;
  reason?: string;
};

export type TradeSim = {
  instrument: string;
  closeTime: string;
  direction: Direction;
  horizon: HorizonId;
  entry: number;
  exit: number;
  grossReturn: number;
  spreadCost: number;
  slippageCost: number;
  netReturn: number;
  mfe: number;
  mae: number;
};

export type MetricBundle = {
  n: number;
  winRate: number;
  grossExpectancy: number;
  netExpectancy: number;
  ci95Low: number;
  ci95High: number;
  profitFactor: number;
  maxDrawdown: number;
  avgSpreadCost: number;
  byPair: Record<string, { n: number; netExpectancy: number }>;
  byMonth: Record<string, { n: number; netExpectancy: number }>;
};

export type ExperimentStatus =
  | "dev_reject"
  | "robustness_reject"
  | "sealed_fail"
  | "sealed_pass"
  | "inconclusive"
  | "error";

export type ExperimentRecord = {
  experimentId: string;
  timestamp: string;
  hypothesis: string;
  modelType: ModelKind;
  featureFamilies: FeatureFamily[];
  featureNames: string[];
  pairUniverse: string[];
  timeframe: string;
  horizon: HorizonId;
  trainDates: { start: string; end: string };
  validationDates: { start: string; end: string };
  sealedDates: { start: string; end: string };
  thresholds: Record<string, number>;
  hyperparameters: Record<string, number | string | boolean>;
  n: number;
  winRate: number;
  grossExpectancy: number;
  netExpectancy: number;
  ci95Low: number;
  ci95High: number;
  sharpeLike: number;
  maxDrawdown: number;
  spreadPaid: number;
  byPair: Record<string, { n: number; netExpectancy: number }>;
  byMonth: Record<string, { n: number; netExpectancy: number }>;
  robustness: Record<string, { pass: boolean; note: string; netExpectancy?: number }>;
  featureImportance: Array<{ name: string; weight: number }>;
  status: ExperimentStatus;
  reason: string;
  sealedTouched: boolean;
  candidateId?: string;
};
