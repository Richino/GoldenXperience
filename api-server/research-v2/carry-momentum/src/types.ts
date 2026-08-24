export type Currency = "USD" | "EUR" | "GBP" | "JPY" | "CHF" | "CAD" | "AUD" | "NZD";

export type Direction = "long" | "short";

export type CmVariant =
  | "momentum_only"
  | "carry_only"
  | "full_agreement"
  | "mom_strong_carry_nonneg"
  | "carry_with_mom_confirm"
  | "mom_carry_50_50"
  | "mom_carry_70_30"
  | "mom_carry_30_70"
  | "mom_carry_vol_filter"
  | "mom_carry_riskoff_filter";

export type YieldObs = {
  currency: Currency;
  seriesId: string;
  /** Calendar date of the observation (YYYY-MM-DD). */
  observationDate: string;
  /** First timestamp the print may be used (ISO). PIT-safe. */
  availableAt: string;
  value: number; // percent
  frequency: "daily" | "monthly";
  source: "fred";
};

export type CurrencyScore = {
  currency: Currency;
  momentum: number;
  carry: number;
  carryChg5: number;
  carryChg20: number;
  combined: number;
  momRank: number;
  carryRank: number;
  combinedRank: number;
  nPairs: number;
};

export type PairSignal = {
  instrument: string;
  direction: Direction;
  strong: Currency;
  weak: Currency;
  momSpread: number;
  carryDiff: number; // base - quote in pair orientation (favors long if >0)
  combinedSpread: number;
  variant: CmVariant;
  closeTime: string;
  ts: number;
};

export type TradeResult = {
  instrument: string;
  direction: Direction;
  entryTime: string;
  exitTime: string;
  holdBars: number;
  grossReturn: number;
  spreadCost: number;
  financingCost: number;
  slippageCost: number;
  netReturn: number;
  netAtr: number;
  variant: CmVariant;
  strong: Currency;
  weak: Currency;
};

export type ExperimentStatus =
  | "dev_reject"
  | "dev_pass"
  | "robustness_reject"
  | "sealed_fail"
  | "sealed_pass"
  | "inconclusive"
  | "error"
  | "data_blocker";

export type CmExperiment = {
  experimentId: string;
  wave: "carry_momentum_wave_1";
  timestamp: string;
  hypothesis: string;
  hypothesisId: string;
  strategyVersion: "carry-momentum-v1";
  variant: CmVariant;
  momentumLookbackBars: number;
  carryMode: "level" | "change" | "level_and_change";
  yieldSource: string;
  timeframe: string;
  holdBars: number;
  stride: number;
  pairUniverse: string[];
  train: { start: string; end: string };
  dev: { start: string; end: string };
  sealed: { start: string; end: string };
  n: number;
  independentN: number;
  winRate: number;
  grossExpectancy: number;
  netExpectancy: number;
  ci95Low: number;
  ci95High: number;
  profitFactor: number;
  maxDrawdown: number;
  totalNet: number;
  avgSpread: number;
  avgFinancing: number;
  byPair: Record<string, { n: number; net: number }>;
  byYear: Record<string, { n: number; net: number }>;
  longN: number;
  shortN: number;
  longNet: number;
  shortNet: number;
  status: ExperimentStatus;
  reason: string;
  sealedTouched: boolean;
  candidateId?: string;
};
