/**
 * GX domain types — vendored from `frontend/src/types/forex.ts`.
 *
 * These are pure structural interfaces of what the existing GX API returns. No
 * business logic is duplicated here. They are copied (not imported across the
 * repo) so the mobile Metro bundler never reaches into the React-19 / Next web
 * project. When web and mobile drift, promote these to `packages/types` and
 * have both import them — the immediate-value bar the brief sets for extraction.
 */

export const MAJOR_INSTRUMENTS = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "AUD_USD",
  "NZD_USD",
  "USD_CAD",
  "USD_CHF",
  "EUR_GBP",
  "EUR_JPY",
  "CAD_JPY",
  "NZD_JPY",
  "GBP_JPY",
  "AUD_JPY",
  "EUR_AUD",
] as const;

export type FeaturedInstrument = (typeof MAJOR_INSTRUMENTS)[number];
export type MajorInstrument = string;
export type DataSource = "oanda" | "forex_factory" | "mock";
export type ConnectionState = "connected" | "not_configured" | "error";

export interface ConnectionStatus {
  state: ConnectionState;
  source: DataSource;
  environment: "practice" | "live";
  label: string;
  message: string;
  checkedAt: string;
}

export interface AccountSummary {
  id: string;
  alias: string;
  currency: string;
  balance: number;
  nav: number;
  unrealizedPL: number;
  marginUsed: number;
  marginAvailable: number;
  openTradeCount: number;
  hedgingEnabled: boolean;
  source: DataSource;
}

export interface AccountBalanceHistoryPoint {
  id: string;
  time: string;
  balance: number;
  change: number;
  type: string;
}

export interface PriceQuote {
  instrument: MajorInstrument;
  displayName: string;
  bid: number;
  ask: number;
  mid: number;
  changePercent: number;
  status: string;
  time: string;
  source: DataSource;
}

export interface OpenPosition {
  id: string;
  instrument: MajorInstrument;
  pair: string;
  direction: "long" | "short";
  units: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPL: number;
  openedAt: string;
  source: DataSource;
}

export interface JournalTrade {
  id: string;
  origin: "demo" | "manual" | "strategy";
  pair: string;
  direction: "long" | "short";
  status: "open" | "closed";
  result: "open" | "win" | "loss" | "breakeven";
  openedAt: string;
  closedAt: string | null;
  entry: number;
  stop: number;
  target: number;
  exit: number | null;
  resultR: number | null;
  paperPl?: number | null;
  reason: string;
  notes: string;
  sequence?: string | null;
  outcome?: string | null;
  instrument?: string | null;
  nominalRiskAmount?: number | null;
  signalPrice?: number | null;
  actualFillPrice?: number | null;
  maxHoldBars?: number | null;
  barsHeld?: number | null;
  strategyFamily?: string | null;
  batchNumber?: number | null;
}
