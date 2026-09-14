/** The pairs featured by default — signals, watchlist and the tick stream. */
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

/**
 * An OANDA instrument name such as "EUR_USD" or "GBP_JPY". Widened from the
 * original three-value union so the whole tradeable catalog is representable;
 * validate untrusted values with isKnownInstrument from lib/instruments/catalog.
 */
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
  /** OANDA account capability; false means opposite orders would net/reduce. */
  hedgingEnabled: boolean;
  source: DataSource;
}

/** A balance-changing transaction reported by the connected OANDA account. */
export interface AccountBalanceHistoryPoint {
  id: string;
  time: string;
  /** Account balance immediately after this transaction. */
  balance: number;
  /** Exact balance movement from the preceding reported transaction. */
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

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete: boolean;
}

export interface CandleSeries {
  instrument: MajorInstrument;
  granularity: string;
  candles: Candle[];
  source: DataSource;
}

export interface TradeSignal {
  instrument: MajorInstrument;
  pair: string;
  timeframe: "15m" | "30m" | "1h" | "4h";
  direction: "long" | "short";
  bias: "Bullish" | "Bearish";
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  strategy: string;
  note: string;
  freshness: string;
  /** Opening time when this signal represents a live paper position. */
  openedAt?: string;
}

/** A chartable paper trade, reduced to what the chart needs to mark it up. */
export interface PaperChartTrade {
  id: string;
  tradeSequence: string;
  instrument: MajorInstrument;
  direction: "long" | "short";
  status: string;
  outcome: string;
  entry: number;
  stop: number;
  target: number;
  exit: number | null;
  resultR: number | null;
  openedAt: string;
  closedAt: string | null;
  exitReason: string | null;
  batchNumber: number | null;
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
  /** Present only when the chart API can resolve this exact trade. */
  chartTradeId?: string | null;
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
  /** Set on strategy-executed trades: the research batch trade number. */
  sequence?: string | null;
  /** Set on strategy-executed trades: how the trade resolved at the broker. */
  outcome?: string | null;
  /** OANDA code, so an open row can be matched to a live quote. `pair` is a
   *  display name and does not join to the watchlist snapshot. */
  instrument?: string | null;
  /** Cash risked between entry and stop, used to value an open trade. */
  nominalRiskAmount?: number | null;
  /** Frozen signal-candle close for pair-specific strategies. */
  signalPrice?: number | null;
  /** Actual OANDA market fill when practice execution supplied it. */
  actualFillPrice?: number | null;
  maxHoldBars?: number | null;
  barsHeld?: number | null;
  /** Multi-strategy family (`ema`, `breakout`, `momentum`, `meanrev`). */
  strategyFamily?: string | null;
  /** Paper batch that collected this trade. */
  batchNumber?: number | null;
  /** The broker refused the submitted order, so no position or cash P&L exists. */
  brokerExecutionStatus?: "rejected" | null;
  /** OANDA's rejection detail, retained separately from the simulated trade outcome. */
  brokerFailureReason?: string | null;
}
