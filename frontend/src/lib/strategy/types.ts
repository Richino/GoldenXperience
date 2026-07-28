import type { DataSource, MajorInstrument } from "@/types/forex";

export type SetupStatus = "valid" | "developing" | "invalid" | "no_setup";
export type StrategyDirection = "long" | "short" | null;

export interface StrategyCondition {
  name: string;
  passed: boolean;
  required: boolean;
  reason: string;
  currentValue: string;
}

export interface StrategyPositionSize {
  riskAmount: number;
  stopDistancePips: number;
  calculatedStandardLots: number;
  calculatedUnits: number;
  calculatedEstimatedRisk: number;
  units: number;
  standardLots: number;
  estimatedRisk: number;
  capStandardLots: number;
  capped: boolean;
}

export interface StrategySetup {
  status: SetupStatus;
  instrument: MajorInstrument;
  pair: string;
  direction: StrategyDirection;
  timeframe: "15m";
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  positionSize: StrategyPositionSize | null;
  summary: string;
  passedConditions: StrategyCondition[];
  failedConditions: StrategyCondition[];
  conditions: StrategyCondition[];
  evaluatedAt: string;
  dataSource: DataSource;
}

export interface StrategyEvaluationInput {
  instrument: MajorInstrument;
  accountBalance: number;
  accountCurrency: string;
  dataSource: DataSource;
  candles15m: import("@/types/forex").Candle[];
  candles1h: import("@/types/forex").Candle[];
  candles4h: import("@/types/forex").Candle[];
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  marketOpen: boolean;
  calendarConnected: boolean;
  highImpactNewsWithinMinutes: number | null;
}

export interface StrategyEvaluationBundle {
  setups: StrategySetup[];
  bestSetup: StrategySetup;
  evaluatedAt: string;
}
