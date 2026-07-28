import { getEconomicCalendar } from "@/lib/calendar/forex-factory";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { getAccountSummary, getCandles, getPricing } from "@/lib/oanda/client";
import { getForexSessionStatus } from "@/lib/strategy/session";
import { evaluateStrategy, rankStrategySetups } from "@/lib/strategy/strategy-engine";
import type { StrategyEvaluationBundle } from "@/lib/strategy/types";
import { MAJOR_INSTRUMENTS, type AccountSummary, type ConnectionStatus, type MajorInstrument } from "@/types/forex";

const CANDLE_COUNT = 260;
const CACHE_MS = 30_000;

export interface StrategySnapshot {
  strategy: StrategyEvaluationBundle;
  account: AccountSummary;
  accountStatus: ConnectionStatus;
  pricingStatus: ConnectionStatus;
  calendarStatus: ConnectionStatus;
}

let cached: { expiresAt: number; snapshot: StrategySnapshot } | null = null;
let inFlight: Promise<StrategySnapshot> | null = null;

function statusIsLive(status: ConnectionStatus) {
  return status.state === "connected" && status.source === "oanda";
}

async function evaluateAll(): Promise<StrategySnapshot> {
  const [accountResult, pricingResult, calendarResult, ...candleResults] = await Promise.all([
    getAccountSummary(),
    getPricing([...MAJOR_INSTRUMENTS]),
    getEconomicCalendar(),
    ...MAJOR_INSTRUMENTS.flatMap((instrument) => [
      getCandles(instrument, "M15", CANDLE_COUNT),
      getCandles(instrument, "H1", CANDLE_COUNT),
      getCandles(instrument, "H4", CANDLE_COUNT),
    ]),
  ]);
  const quoteByInstrument = new Map(pricingResult.data.map((quote) => [quote.instrument, quote]));
  const session = getForexSessionStatus();
  const candlesLive = candleResults.every((result) => statusIsLive(result.status));
  const liveData = statusIsLive(accountResult.status) && statusIsLive(pricingResult.status) && candlesLive;

  const setups = MAJOR_INSTRUMENTS.map((instrument, index) => {
    const quote = quoteByInstrument.get(instrument);
    const [m15, h1, h4] = candleResults.slice(index * 3, index * 3 + 3);
    const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null;
    return evaluateStrategy({
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
      marketOpen: session.marketOpen && session.entrySessionOpen,
      calendarConnected: calendarResult.data.connected,
      highImpactNewsWithinMinutes: calendarResult.data.highImpactNewsWithinMinutes,
    });
  });

  return {
    strategy: rankStrategySetups(setups),
    account: accountResult.data,
    accountStatus: accountResult.status,
    pricingStatus: pricingResult.status,
    calendarStatus: calendarResult.status,
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
