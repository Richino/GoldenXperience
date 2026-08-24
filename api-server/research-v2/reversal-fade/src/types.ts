export type Direction = "long" | "short";
export type Side = "fade" | "follow";
export type Zone = "train" | "dev" | "sealed" | "other";
export type VolBucket = "low" | "normal" | "high" | "extreme";
export type Session = "asia" | "london" | "newyork" | "overlap" | "off";

export type SetupKind =
  | "impulse_1bar"
  | "impulse_multibar"
  | "break20"
  | "structure"
  | "momentum";

export type Signal = {
  instrument: string;
  timeframe: string;
  idx: number;
  closeTime: string;
  ts: number;
  kind: SetupKind;
  param: string;
  impulseDir: Direction; // direction of the confirmed move
  extensionAtr: number;
  session: Session;
  volBucket: VolBucket;
};

export type Trade = {
  instrument: string;
  timeframe: string;
  kind: SetupKind;
  param: string;
  side: Side;
  direction: Direction;
  delay: number;
  horizon: number;
  entryTime: string;
  exitTime: string;
  extensionAtr: number;
  session: Session;
  volBucket: VolBucket;
  grossAtr: number;
  spreadCostAtr: number;
  slippageCostAtr: number;
  netAtr: number;
  mfeAtr: number;
  maeAtr: number;
  retracePct: number | null;
  reversalLag: number | null; // bars until first favorable close; null = never in horizon
};

export type MetricRow = {
  n: number;
  effectiveN: number;
  gross: number;
  net: number;
  ci95Low: number;
  ci95High: number;
  profitFactor: number;
  avgSpreadAtr: number;
  avgSlipAtr: number;
};

export type ExperimentRow = {
  experimentId: string;
  timestamp: string;
  strategyVersion: string;
  zone: Zone;
  instrument: string | "ALL";
  timeframe: string;
  kind: SetupKind;
  param: string;
  side: Side;
  delay: number;
  horizon: number;
  metrics: MetricRow;
  byPair: Record<string, { n: number; net: number }>;
  longNet: number;
  shortNet: number;
  longN: number;
  shortN: number;
  status: "diagnostic" | "dev_reject" | "dev_pass" | "robustness_reject" | "sealed_fail" | "sealed_pass";
  reason: string;
  sealedTouched: boolean;
};
