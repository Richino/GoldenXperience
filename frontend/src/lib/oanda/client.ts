import {
  createMockCandles,
  formatPair,
  mockAccount,
  mockOpenPositions,
  mockPrices,
} from "@/lib/mock-data";
import type {
  AccountSummary,
  CandleSeries,
  ConnectionStatus,
  MajorInstrument,
  OpenPosition,
  PriceQuote,
} from "@/types/forex";

const PRACTICE_URL = "https://api-fxpractice.oanda.com";
const LIVE_URL = "https://api-fxtrade.oanda.com";

interface OandaConfig {
  accountId: string;
  token: string;
  environment: "practice" | "live";
  baseUrl: string;
  timeoutMs: number;
}

interface OandaAccountResponse {
  account: {
    id: string;
    alias?: string;
    currency: string;
    balance: string;
    NAV: string;
    unrealizedPL: string;
    marginAvailable: string;
    openTradeCount: number;
  };
}

interface OandaPricingResponse {
  prices: Array<{
    instrument: MajorInstrument;
    time: string;
    status: string;
    closeoutBid: string;
    closeoutAsk: string;
    bids?: Array<{ price: string }>;
    asks?: Array<{ price: string }>;
  }>;
}

interface OandaOpenTradesResponse {
  trades: Array<{
    id: string;
    instrument: MajorInstrument;
    price: string;
    openTime: string;
    currentUnits: string;
    unrealizedPL: string;
  }>;
}

interface OandaCandlesResponse {
  instrument: MajorInstrument;
  granularity: string;
  candles: Array<{
    time: string;
    volume: number;
    complete: boolean;
    mid?: { o: string; h: string; l: string; c: string };
  }>;
}

export class OandaRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OandaRequestError";
  }
}

function getConfig(): OandaConfig | null {
  const accountId = process.env.OANDA_ACCOUNT_ID?.trim();
  const token =
    process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();

  if (!accountId || !token) {
    return null;
  }

  const environment =
    process.env.OANDA_ENVIRONMENT === "live" ? "live" : "practice";
  const parsedTimeout = Number(process.env.OANDA_REQUEST_TIMEOUT_MS);

  return {
    accountId,
    token,
    environment,
    baseUrl: environment === "practice" ? PRACTICE_URL : LIVE_URL,
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : 8_000,
  };
}

async function requestOanda<T>(path: string): Promise<T> {
  const config = getConfig();

  if (!config) {
    throw new OandaRequestError("OANDA credentials are not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 240);
      throw new OandaRequestError(
        `OANDA returned ${response.status}${body ? `: ${body}` : ""}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof OandaRequestError) {
      throw error;
    }

    const message =
      error instanceof Error && error.name === "AbortError"
        ? "OANDA request timed out."
        : "OANDA could not be reached.";
    throw new OandaRequestError(message);
  } finally {
    clearTimeout(timeout);
  }
}

function buildStatus(
  state: ConnectionStatus["state"],
  message: string,
): ConnectionStatus {
  const config = getConfig();
  const environment = config?.environment ?? "practice";

  return {
    state,
    source: state === "connected" ? "oanda" : "mock",
    environment,
    label:
      state === "connected"
        ? `OANDA ${environment === "practice" ? "Practice" : "Live"}`
        : state === "not_configured"
          ? "Demo data"
          : "OANDA unavailable",
    message,
    checkedAt: new Date().toISOString(),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown OANDA error.";
}

export function isOandaConfigured() {
  return getConfig() !== null;
}

export async function getAccountSummary(): Promise<{
  data: AccountSummary;
  status: ConnectionStatus;
}> {
  const config = getConfig();

  if (!config) {
    return {
      data: mockAccount,
      status: buildStatus(
        "not_configured",
        "Add server-side practice credentials to replace demo account data.",
      ),
    };
  }

  try {
    const response = await requestOanda<OandaAccountResponse>(
      `/v3/accounts/${encodeURIComponent(config.accountId)}/summary`,
    );
    const account = response.account;

    return {
      data: {
        id: account.id,
        alias: account.alias || "OANDA practice",
        currency: account.currency,
        balance: Number(account.balance),
        nav: Number(account.NAV),
        unrealizedPL: Number(account.unrealizedPL),
        marginAvailable: Number(account.marginAvailable),
        openTradeCount: account.openTradeCount,
        source: "oanda",
      },
      status: buildStatus("connected", "Practice account data is live."),
    };
  } catch (error) {
    return {
      data: mockAccount,
      status: buildStatus("error", errorMessage(error)),
    };
  }
}

export async function getPricing(
  instruments: MajorInstrument[],
): Promise<{
  data: PriceQuote[];
  status: ConnectionStatus;
}> {
  const config = getConfig();

  if (!config) {
    return {
      data: mockPrices.filter((price) => instruments.includes(price.instrument)),
      status: buildStatus(
        "not_configured",
        "Showing stable demo quotes until OANDA is configured.",
      ),
    };
  }

  try {
    const response = await requestOanda<OandaPricingResponse>(
      `/v3/accounts/${encodeURIComponent(config.accountId)}/pricing?instruments=${instruments.join(",")}`,
    );

    return {
      data: response.prices.map((price) => {
        const bid = Number(price.bids?.[0]?.price ?? price.closeoutBid);
        const ask = Number(price.asks?.[0]?.price ?? price.closeoutAsk);

        return {
          instrument: price.instrument,
          displayName: formatPair(price.instrument),
          bid,
          ask,
          mid: (bid + ask) / 2,
          changePercent: 0,
          status: price.status.toLowerCase(),
          time: price.time,
          source: "oanda",
        };
      }),
      status: buildStatus("connected", "Live practice pricing is available."),
    };
  } catch (error) {
    return {
      data: mockPrices.filter((price) => instruments.includes(price.instrument)),
      status: buildStatus("error", errorMessage(error)),
    };
  }
}

export async function getCandles(
  instrument: MajorInstrument,
  granularity = "M15",
  count = 64,
  options: { to?: string } = {},
): Promise<{
  data: CandleSeries;
  status: ConnectionStatus;
}> {
  if (!getConfig()) {
    return {
      data: createMockCandles(instrument, count, granularity, options.to),
      status: buildStatus(
        "not_configured",
        "Showing generated candle data until OANDA is configured.",
      ),
    };
  }

  try {
    const params = new URLSearchParams({
      price: "M",
      granularity,
      count: String(count),
    });

    if (options.to) {
      params.set("to", options.to);
    }

    const response = await requestOanda<OandaCandlesResponse>(
      `/v3/instruments/${instrument}/candles?${params.toString()}`,
    );

    const candles = response.candles.flatMap((candle) =>
      candle.mid
        ? [
            {
              time: candle.time,
              open: Number(candle.mid.o),
              high: Number(candle.mid.h),
              low: Number(candle.mid.l),
              close: Number(candle.mid.c),
              volume: candle.volume,
              complete: candle.complete,
            },
          ]
        : [],
    );

    return {
      data: {
        instrument,
        granularity: response.granularity,
        candles,
        source: "oanda",
      },
      status: buildStatus("connected", "OANDA candles loaded."),
    };
  } catch (error) {
    return {
      data: createMockCandles(instrument, count, granularity, options.to),
      status: buildStatus("error", errorMessage(error)),
    };
  }
}

export async function getOpenPositions(): Promise<{
  data: OpenPosition[];
  status: ConnectionStatus;
}> {
  const config = getConfig();

  if (!config) {
    return {
      data: mockOpenPositions,
      status: buildStatus(
        "not_configured",
        "Showing a demo open position until OANDA is configured.",
      ),
    };
  }

  try {
    const response = await requestOanda<OandaOpenTradesResponse>(
      `/v3/accounts/${encodeURIComponent(config.accountId)}/openTrades`,
    );

    if (response.trades.length === 0) {
      return {
        data: [],
        status: buildStatus("connected", "No open positions."),
      };
    }

    const instruments = [
      ...new Set(response.trades.map((trade) => trade.instrument)),
    ];
    const pricing = await getPricing(instruments);
    const priceByInstrument = new Map(
      pricing.data.map((price) => [price.instrument, price.mid]),
    );

    const data: OpenPosition[] = response.trades.map((trade) => {
      const currentUnits = Number(trade.currentUnits);

      return {
        id: trade.id,
        instrument: trade.instrument,
        pair: formatPair(trade.instrument),
        direction: currentUnits >= 0 ? "long" : "short",
        units: Math.abs(currentUnits),
        entryPrice: Number(trade.price),
        currentPrice:
          priceByInstrument.get(trade.instrument) ?? Number(trade.price),
        unrealizedPL: Number(trade.unrealizedPL),
        openedAt: trade.openTime,
        source: "oanda",
      };
    });

    return {
      data,
      status: buildStatus("connected", "Live open positions loaded."),
    };
  } catch (error) {
    return {
      data: mockOpenPositions,
      status: buildStatus("error", errorMessage(error)),
    };
  }
}

export async function testOandaConnection(): Promise<ConnectionStatus> {
  const result = await getAccountSummary();
  return result.status;
}
