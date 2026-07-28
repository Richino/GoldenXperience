import type { MajorInstrument } from "./market-stream-types.js";

export interface MarketStreamConfig {
  accountId: string | null;
  apiKey: string | null;
  environment: "practice" | "live";
  streamBaseUrl: string;
  port: number;
  instruments: MajorInstrument[];
  isConfigured: boolean;
}
