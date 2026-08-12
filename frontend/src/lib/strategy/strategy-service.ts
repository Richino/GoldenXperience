import { pipSizeFor } from "@/lib/instruments/catalog";
import { getAccountSummary, getCandles, getPricing } from "@/lib/oanda/client";
import { getPaperTradingAvailability, rankStrategySetups } from "@/lib/strategy/strategy-engine";
import { evaluateLiquiditySetup } from "@/lib/strategy/liquidity-strategy";
import { highImpactMinutesFor, macroBiasFor } from "@/lib/macro/rates";
import { getEconomicCalendar } from "@/lib/calendar/forex-factory";
import type { StrategyEvaluationBundle } from "@/lib/strategy/types";
import { MAJOR_INSTRUMENTS, type AccountSummary, type ConnectionStatus, type MajorInstrument, type PriceQuote } from "@/types/forex";

const CANDLE_COUNT = 260;
const CACHE_MS = 30_000;

export interface StrategySnapshot {
  strategy: StrategyEvaluationBundle;
  account: AccountSummary;
  accountStatus: ConnectionStatus;
  pricingStatus: ConnectionStatus;
  calendarStatus: ConnectionStatus;
  quotes: PriceQuote[];
}

let cached: { expiresAt: number; snapshot: StrategySnapshot } | null = null;
let inFlight: Promise<StrategySnapshot> | null = null;

function statusIsLive(status: ConnectionStatus) {
  return status.state === "connected" && status.source === "oanda";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function evaluateAll(): Promise<StrategySnapshot> {
  const [accountResult, pricingResult] = await Promise.all([
    getAccountSummary(),
    getPricing([...MAJOR_INSTRUMENTS]),
  ]);
  const candleRequests = MAJOR_INSTRUMENTS.flatMap((instrument) => [
    { instrument, timeframe: "M15" },
    { instrument, timeframe: "H1" },
    { instrument, timeframe: "H4" },
  ]);
  const candleResults = await mapWithConcurrency(candleRequests, 5, (request) => getCandles(request.instrument, request.timeframe, CANDLE_COUNT));
  const quoteByInstrument = new Map(pricingResult.data.map((quote) => [quote.instrument, quote]));
  const availability = getPaperTradingAvailability();
  // One macro read per pair per snapshot. The module caches across calls, so
  // ten pairs cost one FRED fetch rather than ten.
  const macroReads = new Map(
    await Promise.all(MAJOR_INSTRUMENTS.map(async (instrument) => [instrument, await macroBiasFor(instrument)] as const)),
  );
  // Fetched once and filtered per pair below. A failed or stale feed blocks
  // entries: it cannot prove the 30-minute high-impact-news buffer is clear.
  const calendar = await getEconomicCalendar();
  // A feed whose coverage stops before the buffer window cannot clear a trade:
  // finding no event there means the data ran out, not that the diary is empty.
  // The weekly ForexFactory file does exactly that every Friday. Treated as
  // unusable it pauses entries; treated as connected it would report an
  // all-clear the data does not support.
  const NEWS_BUFFER_MINUTES = 30;
  const coverageMs = calendar.data.coverageUntil ? Date.parse(calendar.data.coverageUntil) : Number.NaN;
  const newsUsable = calendar.data.connected
    && Number.isFinite(coverageMs)
    && coverageMs - Date.now() >= NEWS_BUFFER_MINUTES * 60_000;
  const accountAndPricingLive = statusIsLive(accountResult.status) && statusIsLive(pricingResult.status);

  const setups = MAJOR_INSTRUMENTS.map((instrument, index) => {
    const macro = macroReads.get(instrument);
    const quote = quoteByInstrument.get(instrument);
    const [m15, h1, h4] = candleResults.slice(index * 3, index * 3 + 3);
    const pairCandlesLive = [m15, h1, h4].every((result) => result && statusIsLive(result.status));
    const quoteFresh = Boolean(quote && Date.now() - new Date(quote.time).getTime() <= 2 * 60_000);
    const liveData = accountAndPricingLive && pairCandlesLive && quoteFresh;
    const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null;
    const lastCompleted = m15?.data.candles.filter((candle) => candle.complete).at(-1);
    const evaluatedAt = lastCompleted
      ? new Date(new Date(lastCompleted.time).getTime() + 15 * 60_000).toISOString()
      : new Date().toISOString();
    return evaluateLiquiditySetup({
      instrument,
      accountBalance: accountResult.data.balance,
      accountCurrency: accountResult.data.currency,
      dataSource: liveData ? "oanda" : "mock",
      candles15m: m15?.data.candles ?? [],
      candles1h: h1?.data.candles ?? [],
      candles4h: h4?.data.candles ?? [],
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spreadPips,
      marketOpen: availability.marketOpen,
      calendarConnected: newsUsable,
      highImpactNewsWithinMinutes: newsUsable ? highImpactMinutesFor(instrument, calendar.data.events) : null,
      newsRequired: true,
      evaluatedAt,
      macroBias: macro?.bias ?? "neutral",
      macroDetail: macro?.detail,
    });
  });

  return {
    strategy: rankStrategySetups(setups),
    account: accountResult.data,
    accountStatus: accountResult.status,
    pricingStatus: pricingResult.status,
    calendarStatus: calendar.status,
    quotes: pricingResult.data,
  };
}

/**
 * A short cache prevents a dashboard refresh from making nine candle calls and
 * a pricing call for every client render. It is intentionally request-driven:
 * the tick stream remains the source for intra-candle price displays.
 */
export async function getStrategySnapshot(): Promise<StrategySnapshot> {
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
  inFlight ??= evaluateAll().then((snapshot) => {
    cached = { snapshot, expiresAt: Date.now() + CACHE_MS };
    return snapshot;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function clearStrategySnapshotCache() {
  cached = null;
}

export function isStrategyInstrument(value: string): value is MajorInstrument {
  return (MAJOR_INSTRUMENTS as readonly string[]).includes(value);
}
