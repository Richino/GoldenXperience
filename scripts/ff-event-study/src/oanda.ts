/**
 * Minimal, standalone OANDA candle reader.
 *
 * Deliberately NOT importing the app's `@/lib/oanda/client` — that module is
 * wired for Next.js path aliases and silently falls back to MOCK candles when
 * creds are missing, which would poison a research dataset without warning.
 * Here a missing key is a hard error, and every candle is real broker mid data.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Reuse the same credentials the api-server already runs on.
loadEnv({ path: resolve(here, "../../../api-server/.env") });
// Allow a local override without editing api-server/.env.
loadEnv({ path: resolve(here, "../.env"), override: true });

const ENVIRONMENT = process.env.OANDA_ENVIRONMENT === "live" ? "live" : "practice";
const BASE_URL =
  ENVIRONMENT === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";
const TOKEN = (process.env.OANDA_API_KEY || process.env.OANDA_API_TOKEN || "").trim();

if (!TOKEN) {
  throw new Error(
    "OANDA_API_KEY is not set. Expected it in api-server/.env (or scripts/ff-event-study/.env).",
  );
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

interface CandlesResponse {
  candles: Array<{
    time: string;
    volume: number;
    complete: boolean;
    mid?: { o: string; h: string; l: string; c: string };
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mid candles for `instrument` between `from` and `to` (ISO strings), inclusive.
 * Retries transient failures; throws on a hard OANDA error so bad data never
 * enters the dataset silently.
 */
export async function getCandles(
  instrument: string,
  granularity: string,
  from: Date,
  to: Date,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    price: "M",
    granularity,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const url = `${BASE_URL}/v3/instruments/${instrument}/candles?${params}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (response.status === 429 || response.status >= 500) {
        // Rate-limited or transient — back off and retry.
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        throw new Error(`OANDA ${instrument} ${granularity} -> ${response.status}: ${body}`);
      }
      const data = (await response.json()) as CandlesResponse;
      return data.candles.flatMap((c) =>
        c.mid
          ? [
              {
                time: c.time,
                open: Number(c.mid.o),
                high: Number(c.mid.h),
                low: Number(c.mid.l),
                close: Number(c.mid.c),
                volume: c.volume,
                complete: c.complete,
              },
            ]
          : [],
      );
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(
    `OANDA request failed for ${instrument} after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export { ENVIRONMENT as OANDA_ENVIRONMENT };
