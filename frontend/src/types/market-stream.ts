import type { MajorInstrument } from "@/types/forex";

export type MarketDataSource = "oanda" | "mock";
export type MarketStreamState =
  | "idle"
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
  state: Exclude<MarketStreamState, "idle">;
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

export type MarketStreamMessage =
  | MarketPriceTick
  | MarketStreamStatus
  | MarketStreamHeartbeat;
