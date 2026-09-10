/**
 * Shapes of the GX API payloads the mobile client reads. Trimmed to the fields
 * Phase 1 consumes; widen as later screens need more. Mirrors the web's
 * `StrategySetup` (lib/strategy/types.ts) and the dashboard row types
 * (components/dashboard/dashboard-view.tsx).
 */
import type {
  AccountBalanceHistoryPoint,
  AccountSummary,
  ConnectionStatus,
  JournalTrade,
  OpenPosition,
  PriceQuote,
} from "@/types/forex";

/** OANDA-backed endpoints wrap their body as `{ data, status }`. */
export interface OandaEnvelope<T> {
  data: T;
  status: ConnectionStatus;
}

export type SetupStatus = "valid" | "developing" | "invalid" | "no_setup";
export type StrategyDirection = "long" | "short" | null;

export interface StrategySetup {
  status: SetupStatus;
  instrument: string;
  pair: string;
  direction: StrategyDirection;
  timeframe: "15m" | "30m" | "1h";
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  positionSize: { standardLots?: number | null } | null;
  summary: string;
  evaluatedAt: string;
}

export interface StrategySnapshot {
  strategy: { setups: StrategySetup[] };
}

/** One `/api/watchlist` row — only the fields the signal join needs. */
export interface WatchRow {
  instrument: string;
  evaluatedAt: string | null;
  direction: "long" | "short" | null;
  bid: number | null;
  ask: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  openTradeId: string | null;
}

export interface StrategyRow {
  instrument: string;
  strategies: {
    family: "ema" | "breakout" | "momentum" | "meanrev";
    version: string;
    setupStatus: SetupStatus;
    direction: "long" | "short" | null;
    selected: boolean;
    openTradeId: string | null;
  }[];
}

export interface OverviewTrade {
  id: string;
  tradeSequence: string;
  instrument: string;
  direction: "long" | "short";
  status: string;
  outcome: string;
  resultR: number | null;
  paperPl?: number | null;
  openedAt: string;
  closedAt?: string | null;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  nominalRiskAmount?: number | null;
  strategyFamily?: string | null;
  batchNumber?: number | null;
}

export interface PaperCycleOverview {
  openTrades?: OverviewTrade[];
  trades: OverviewTrade[];
}

export interface JournalResponse {
  trades: JournalTrade[];
  hasMore: boolean;
  summary?: {
    total: number;
    winRate: number | null;
    avgR: number;
    today?: { wins: number; losses: number; realizedPL: number | null };
  };
}

export type {
  AccountBalanceHistoryPoint,
  AccountSummary,
  ConnectionStatus,
  JournalTrade,
  OpenPosition,
  PriceQuote,
};
