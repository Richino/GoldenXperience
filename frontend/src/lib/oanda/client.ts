import {
  createMockCandles,
  formatPair,
  mockAccount,
  mockOpenPositions,
  mockPrices,
} from "@/lib/mock-data";
import type {
  AccountSummary,
  AccountBalanceHistoryPoint,
  CandleSeries,
  ConnectionStatus,
  MajorInstrument,
  OpenPosition,
  PriceQuote,
} from "@/types/forex";
import { precisionFor } from "@/lib/instruments/catalog";

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

interface OandaTransactionsResponse {
  pages?: string[];
  transactions?: Array<{
    id: string;
    time: string;
    type: string;
    accountBalance?: string;
  }>;
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

type OandaOrderResponse = {
  orderCreateTransaction?: { id?: string };
  orderFillTransaction?: { id?: string; tradeOpened?: { tradeID?: string } };
};

interface OandaCandlesResponse {
  instrument: MajorInstrument;
  granularity: string;
  candles: Array<{
    time: string;
    volume: number;
    complete: boolean;
    mid?: { o: string; h: string; l: string; c: string };
    bid?: { o: string; h: string; l: string; c: string };
    ask?: { o: string; h: string; l: string; c: string };
  }>;
}

export type ResearchCandle = { time: string; volume: number; complete: boolean; mid: { open: number; high: number; low: number; close: number }; bid: { open: number; high: number; low: number; close: number }; ask: { open: number; high: number; low: number; close: number } };

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

async function requestOanda<T>(path: string, options: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}): Promise<T> {
  const config = getConfig();

  if (!config) {
    throw new OandaRequestError("OANDA credentials are not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

export type PracticeMarketOrder = {
  instrument: MajorInstrument;
  direction: "long" | "short";
  units: number;
  stop: number;
  target: number;
  clientRequestId: string;
};

export function signedPracticeUnits(direction: "long" | "short", units: number) {
  const absoluteUnits = Math.floor(Math.abs(units));
  return direction === "long" ? absoluteUnits : -absoluteUnits;
}

export async function submitPracticeMarketOrder(order: PracticeMarketOrder) {
  const config = getConfig();
  if (!config) throw new OandaRequestError("OANDA credentials are not configured.");
  if (config.environment !== "practice") throw new OandaRequestError("Automatic execution is locked to OANDA practice accounts.");
  const units = Math.floor(Math.abs(order.units));
  if (!Number.isFinite(units) || units < 1) throw new OandaRequestError("Calculated practice order size is invalid.");
  const precision = precisionFor(order.instrument);
  const response = await requestOanda<OandaOrderResponse>(`/v3/accounts/${encodeURIComponent(config.accountId)}/orders`, {
    method: "POST",
    body: {
      order: {
        type: "MARKET",
        instrument: order.instrument,
        units: String(signedPracticeUnits(order.direction, units)),
        timeInForce: "FOK",
        positionFill: "DEFAULT",
        stopLossOnFill: { price: order.stop.toFixed(precision), timeInForce: "GTC" },
        takeProfitOnFill: { price: order.target.toFixed(precision), timeInForce: "GTC" },
        clientExtensions: { id: `gx-${order.clientRequestId}`, tag: "goldenxperience-practice" },
      },
    },
  });
  return {
    orderId: response.orderCreateTransaction?.id ?? response.orderFillTransaction?.id ?? null,
    tradeId: response.orderFillTransaction?.tradeOpened?.tradeID ?? null,
  };
}

export async function closePracticeTrade(brokerTradeId: string) {
  const config = getConfig();
  if (!config) throw new OandaRequestError("OANDA credentials are not configured.");
  if (config.environment !== "practice") throw new OandaRequestError("Automatic execution is locked to OANDA practice accounts.");
  if (!brokerTradeId) throw new OandaRequestError("Broker trade identifier is unavailable.");
  const response = await requestOanda<{ orderFillTransaction?: { id?: string }; orderCreateTransaction?: { id?: string } }>(`/v3/accounts/${encodeURIComponent(config.accountId)}/trades/${encodeURIComponent(brokerTradeId)}/close`, {
    method: "PUT",
    body: { units: "ALL" },
  });
  return response.orderFillTransaction?.id ?? response.orderCreateTransaction?.id ?? null;
}

export interface PracticeTradeState {
  /** OANDA reports OPEN, CLOSED or CLOSE_WHEN_TRADEABLE. */
  state: string;
  closed: boolean;
  /** Price the position actually closed at, averaged over its closing fills. */
  averageClosePrice: number | null;
  /** Cash the broker actually booked, in the account currency. */
  realizedPL: number | null;
  closeTime: string | null;
}

/**
 * The broker's own record of a trade it executed.
 *
 * This is the authority on whether a position is still open and what it earned.
 * Reading it beats inferring an outcome from candles: the broker knows the
 * moment its own stop or take-profit fills, and it reports the price it filled
 * at rather than the level the order was resting on — which differ by whatever
 * the market gapped or slipped.
 */
export async function getPracticeTradeState(brokerTradeId: string): Promise<PracticeTradeState | null> {
  const config = getConfig();
  if (!config || !brokerTradeId) return null;

  const response = await requestOanda<{
    trade?: {
      state?: string;
      averageClosePrice?: string;
      realizedPL?: string;
      closeTime?: string;
    };
  }>(`/v3/accounts/${encodeURIComponent(config.accountId)}/trades/${encodeURIComponent(brokerTradeId)}`);

  const trade = response.trade;
  if (!trade?.state) return null;

  const numberOrNull = (value: string | undefined) => {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    state: trade.state,
    closed: trade.state === "CLOSED",
    averageClosePrice: numberOrNull(trade.averageClosePrice),
    realizedPL: numberOrNull(trade.realizedPL),
    closeTime: trade.closeTime ?? null,
  };
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

/**
 * Returns real balance movements from OANDA's transaction ledger.
 *
 * The dashboard used to add internal `paper_pl` estimates backwards from the
 * broker's current NAV. That made the plotted amounts look authoritative even
 * when broker fills, financing, or manual transactions did not equal those
 * estimates. Each point below is an actual OANDA-reported account balance.
 */
export async function getAccountBalanceHistory(): Promise<{
  data: AccountBalanceHistoryPoint[];
  status: ConnectionStatus;
}> {
  const config = getConfig();
  if (!config) {
    return {
      data: [],
      status: buildStatus("not_configured", "Add server-side practice credentials to load broker account history."),
    };
  }

  try {
    const accountPath = `/v3/accounts/${encodeURIComponent(config.accountId)}`;
    const index = await requestOanda<OandaTransactionsResponse>(`${accountPath}/transactions?pageSize=1000`);
    const pagePaths = (index.pages ?? []).slice(-5).map((page) => {
      const url = new URL(page, config.baseUrl);
      if (url.origin !== config.baseUrl) throw new OandaRequestError("OANDA returned an unexpected transaction page.");
      return `${url.pathname}${url.search}`;
    });
    const pages = pagePaths.length
      ? await Promise.all(pagePaths.map((page) => requestOanda<OandaTransactionsResponse>(page)))
      : [index];
    const transactions = pages
      .flatMap((page) => page.transactions ?? [])
      .map((transaction) => ({ ...transaction, balance: Number(transaction.accountBalance) }))
      .filter((transaction) => Number.isFinite(transaction.balance) && Number.isFinite(new Date(transaction.time).getTime()))
      .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime() || Number(left.id) - Number(right.id));

    let precedingBalance: number | null = null;
    const data: AccountBalanceHistoryPoint[] = [];
    for (const transaction of transactions) {
      const change = precedingBalance === null ? 0 : transaction.balance - precedingBalance;
      precedingBalance = transaction.balance;
      // Account configuration and order creation events commonly repeat the
      // same balance; drawing them would fabricate flat "trades" in the chart.
      if (Math.abs(change) < 0.000_001) continue;
      data.push({
        id: transaction.id,
        time: transaction.time,
        balance: transaction.balance,
        change,
        type: transaction.type,
      });
    }

    return { data, status: buildStatus("connected", "Practice account history is live.") };
  } catch (error) {
    return {
      data: [],
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

export async function getResearchCandles(instrument: MajorInstrument, granularity: string, count: number, options: { to?: string } = {}): Promise<ResearchCandle[]> {
  if (!getConfig()) throw new OandaRequestError("OANDA credentials are not configured.");
  const params = new URLSearchParams({ price: "MBA", granularity, count: String(count) }); if (options.to) params.set("to", options.to);
  const response = await requestOanda<OandaCandlesResponse>(`/v3/instruments/${instrument}/candles?${params}`);
  return response.candles.flatMap((c) => c.mid && c.bid && c.ask ? [{ time: c.time, volume: c.volume, complete: c.complete, mid: { open: Number(c.mid.o), high: Number(c.mid.h), low: Number(c.mid.l), close: Number(c.mid.c) }, bid: { open: Number(c.bid.o), high: Number(c.bid.h), low: Number(c.bid.l), close: Number(c.bid.c) }, ask: { open: Number(c.ask.o), high: Number(c.ask.h), low: Number(c.ask.l), close: Number(c.ask.c) } }] : []);
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
