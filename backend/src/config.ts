import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { STREAM_INSTRUMENTS, type MajorInstrument } from "./types.js";

const PRACTICE_STREAM_URL = "https://stream-fxpractice.oanda.com";
const LIVE_STREAM_URL = "https://stream-fxtrade.oanda.com";

export interface MarketStreamConfig {
  accountId: string | null;
  apiKey: string | null;
  environment: "practice" | "live";
  streamBaseUrl: string;
  port: number;
  instruments: MajorInstrument[];
  isConfigured: boolean;
}

function loadEnvFiles() {
  const cwd = process.cwd();
  const projectRoot = path.resolve(cwd, "..");
  const candidates = [
    projectRoot,
    path.join(projectRoot, "frontend"),
    cwd,
  ];

  for (const dir of candidates) {
    for (const file of [".env", ".env.local"]) {
      const envPath = path.join(dir, file);

      if (fs.existsSync(envPath)) {
        loadDotenv({ path: envPath, override: false });
      }
    }
  }
}

function parsePort(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8787;
}

function parseInstruments(value: string | undefined) {
  if (!value) return [...STREAM_INSTRUMENTS];

  const allowed = new Set<string>(STREAM_INSTRUMENTS);
  const instruments = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is MajorInstrument => allowed.has(item));

  return instruments.length ? instruments : [...STREAM_INSTRUMENTS];
}

export function getMarketStreamConfig(): MarketStreamConfig {
  loadEnvFiles();

  const environment =
    process.env.OANDA_ENVIRONMENT === "live" ? "live" : "practice";
  const accountId = process.env.OANDA_ACCOUNT_ID?.trim() || null;
  const apiKey =
    process.env.OANDA_API_KEY?.trim() ||
    process.env.OANDA_API_TOKEN?.trim() ||
    null;

  return {
    accountId,
    apiKey,
    environment,
    streamBaseUrl:
      environment === "practice" ? PRACTICE_STREAM_URL : LIVE_STREAM_URL,
    port: parsePort(process.env.MARKET_STREAM_WS_PORT),
    instruments: parseInstruments(process.env.MARKET_STREAM_INSTRUMENTS),
    isConfigured: Boolean(accountId && apiKey),
  };
}
