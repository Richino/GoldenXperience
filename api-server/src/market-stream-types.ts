export const STREAM_INSTRUMENTS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD"] as const;

export type MajorInstrument = string;
export type MarketDataSource = "oanda" | "mock";
export type MarketStreamState =
  | "connecting"
  | "connected"
  | "mock"
  | "error"
  | "closed";

export interface MarketPriceTick {
  type: "price";
  instrument: MajorInstrument;
  displayName: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  status: string;
  time: string;
  source: MarketDataSource;
  sequence: number;
}

export interface MarketStreamStatus {
  type: "status";
  state: MarketStreamState;
  source: MarketDataSource;
  environment: "practice" | "live";
  message: string;
  instruments: MajorInstrument[];
  connectedClients: number;
  checkedAt: string;
}

export interface MarketStreamHeartbeat {
  type: "heartbeat";
  source: MarketDataSource;
  time: string;
}

export interface MarketStreamSubscribe {
  type: "subscribe";
  instruments?: MajorInstrument[];
}

export type MarketStreamMessage =
  | MarketPriceTick
  | MarketStreamStatus
  | MarketStreamHeartbeat;
