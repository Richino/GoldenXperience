/** The pairs featured by default — signals, watchlist and the tick stream. */
export const MAJOR_INSTRUMENTS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;

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
  marginAvailable: number;
  openTradeCount: number;
  source: DataSource;
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
  timeframe: "15m" | "1h" | "4h";
  direction: "long" | "short";
  bias: "Bullish" | "Bearish";
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  strategy: string;
  note: string;
  freshness: string;
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
  origin: "demo" | "manual";
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
  reason: string;
  notes: string;
}
