import { currenciesOf, pipSizeFor } from "@/lib/instruments/catalog";
import type { MajorInstrument } from "@/types/forex";
import type { MarketStreamState } from "@/types/market-stream";

export const DEFAULT_RISK_POLICY = {
  riskPercent: 1,
  maxDailyLossPercent: 2,
  maxTradesPerDay: 3,
  maxConsecutiveLosses: 2,
} as const;

function configuredPaperLotCap() {
  const value = Number(process.env.NEXT_PUBLIC_PAPER_MAX_STANDARD_LOTS);
  return Number.isFinite(value) && value > 0 ? value : 2;
}

/** A simulation guard only. It does not place, modify, or constrain OANDA orders. */
export const PAPER_TRADING_MAX_STANDARD_LOTS = configuredPaperLotCap();

/**
 * Spread is derived as `(ask - bid) / pipSize`, so a spread that is exactly at
 * the limit lands a few ulps above it — EUR_USD at 1.5 pips evaluates to
 * 1.5000000000009452 and a bare `<=` rejects an otherwise valid setup. The
 * tolerance is far below the 0.1-pip precision the limits are written in, so it
 * only absorbs that representation error.
 */
const SPREAD_EPSILON_PIPS = 1e-6;

export function spreadWithinLimit(spreadPips: number | null, maxSpreadPips: number) {
  return spreadPips !== null && Number.isFinite(spreadPips) && spreadPips <= maxSpreadPips + SPREAD_EPSILON_PIPS;
}

export type TradePermission = "allowed" | "blocked";

export interface TradePermissionInput {
  restConnected: boolean;
  streamState: MarketStreamState;
  marketOpen: boolean;
  calendarConnected: boolean;
  dailyLossPercent: number;
  tradesTaken: number;
  consecutiveLosses: number;
  setupValid: boolean;
  highImpactNewsWithinMinutes: number | null;
  spreadPips: number | null;
  maxSpreadPips?: number;
}

export interface TradePermissionDecision {
  permission: TradePermission;
  label: "Trading Allowed" | "Trading Blocked";
  reason: string;
}

export interface PositionSizeInput {
  instrument: MajorInstrument;
  accountBalance: number;
  riskPercent: number;
  entry: number;
  stop: number;
  /** Research collection can retain the full nominal 1% calculation. */
  applyPaperCap?: boolean;
  /**
   * USD value of one unit of the pair's quote currency, from
   * {@link usdPerUnitOfCurrency}. Required for a correct pip value on true
   * crosses (EUR_GBP, EUR_JPY, GBP_JPY); omit for USD-base/quote pairs.
   */
  quoteToUsdRate?: number;
}

export interface PositionSizeResult {
  riskAmount: number;
  stopDistancePips: number;
  pipValuePerStandardLot: number;
  calculatedStandardLots: number;
  calculatedUnits: number;
  calculatedEstimatedRisk: number;
  standardLots: number;
  units: number;
  estimatedRisk: number;
  capStandardLots: number;
  capped: boolean;
}

function hasPositiveFiniteValues(values: number[]) {
  return values.every((value) => Number.isFinite(value) && value > 0);
}

export function getPipSize(instrument: MajorInstrument) {
  return pipSizeFor(instrument);
}

/**
 * How many USD one unit of `currency` is worth, read from whichever major
 * carries it against USD. A true cross such as EUR_GBP, EUR_JPY or GBP_JPY is
 * quoted in a currency whose USD value cannot be read from the pair's own price
 * — EUR_JPY tells you nothing about JPY against USD — so pip value on those
 * pairs needs this rate from a second instrument (USD_JPY, GBP_USD, ...).
 *
 * `midByInstrument` returns an instrument's mid price, or null when it is not
 * available. Returns null when no USD pair for the currency is known.
 */
export function usdPerUnitOfCurrency(
  currency: string,
  midByInstrument: (instrument: string) => number | null,
): number | null {
  if (currency === "USD") return 1;
  const direct = midByInstrument(`${currency}_USD`);
  if (direct !== null && Number.isFinite(direct) && direct > 0) return direct;
  const inverse = midByInstrument(`USD_${currency}`);
  if (inverse !== null && Number.isFinite(inverse) && inverse > 0) return 1 / inverse;
  return null;
}

export function getPipValuePerStandardLot(
  instrument: MajorInstrument,
  price: number,
  quoteToUsdRate?: number,
) {
  if (!Number.isFinite(price) || price <= 0) return 0;

  // A standard lot moves the quote currency by pipSize * 100_000 per pip. For a
  // USD-denominated account that is exactly $10 when the quote is USD, and
  // otherwise the quote-currency amount converted into USD.
  const { quote } = currenciesOf(instrument);
  if (quote === "USD") return 10;

  const quoteMovePerPip = pipSizeFor(instrument) * 100_000;

  // Preferred: the caller resolved the quote currency's USD value from live
  // majors. This is the only correct source for a true cross (EUR_GBP, EUR_JPY,
  // GBP_JPY), whose own price says nothing about its quote currency versus USD.
  if (quoteToUsdRate !== undefined && Number.isFinite(quoteToUsdRate) && quoteToUsdRate > 0) {
    return quoteMovePerPip * quoteToUsdRate;
  }

  // Fallback when no rate is supplied: 1/price is the quote->USD rate only when
  // USD is the base (USD_JPY, USD_CAD, USD_CHF). For a true cross this is an
  // approximation; the data-collection path always supplies a rate instead.
  return quoteMovePerPip / price;
}

export function calculatePositionSize(
  input: PositionSizeInput,
): PositionSizeResult | null {
  if (
    !hasPositiveFiniteValues([
      input.accountBalance,
      input.riskPercent,
      input.entry,
      input.stop,
    ]) ||
    input.entry === input.stop
  ) {
    return null;
  }

  const riskAmount = input.accountBalance * (input.riskPercent / 100);
  const stopDistancePips =
    Math.abs(input.entry - input.stop) / getPipSize(input.instrument);
  const pipValuePerStandardLot = getPipValuePerStandardLot(
    input.instrument,
    input.entry,
    input.quoteToUsdRate,
  );

  if (!hasPositiveFiniteValues([riskAmount, stopDistancePips, pipValuePerStandardLot])) {
    return null;
  }

  const rawLots = riskAmount / (stopDistancePips * pipValuePerStandardLot);
  const calculatedUnits = Math.max(
    0,
    Math.floor(Number((rawLots * 100_000).toFixed(8))),
  );
  const calculatedStandardLots = calculatedUnits / 100_000;
  const capStandardLots = PAPER_TRADING_MAX_STANDARD_LOTS;
  const capped = input.applyPaperCap !== false && calculatedStandardLots > capStandardLots;
  const standardLots = capped ? capStandardLots : calculatedStandardLots;
  const units = Math.floor(standardLots * 100_000);
  const calculatedEstimatedRisk = Number(
    (calculatedStandardLots * stopDistancePips * pipValuePerStandardLot).toFixed(2),
  );
  const estimatedRisk = Number(
    (standardLots * stopDistancePips * pipValuePerStandardLot).toFixed(2),
  );

  return {
    riskAmount,
    stopDistancePips,
    pipValuePerStandardLot,
    calculatedStandardLots,
    calculatedUnits,
    calculatedEstimatedRisk,
    standardLots,
    units,
    estimatedRisk,
    capStandardLots,
    capped,
  };
}

export function deriveTradePermission(
  input: TradePermissionInput,
): TradePermissionDecision {
  const blocked = (reason: string): TradePermissionDecision => ({
    permission: "blocked",
    label: "Trading Blocked",
    reason,
  });

  if (input.dailyLossPercent >= DEFAULT_RISK_POLICY.maxDailyLossPercent) {
    return blocked("The daily loss limit has been reached.");
  }

  if (input.tradesTaken >= DEFAULT_RISK_POLICY.maxTradesPerDay) {
    return blocked("The maximum number of trades has been reached.");
  }

  if (
    input.consecutiveLosses >= DEFAULT_RISK_POLICY.maxConsecutiveLosses
  ) {
    return blocked("Two consecutive losses ends the session.");
  }

  if (!input.restConnected) {
    return blocked("OANDA account data is not connected.");
  }

  if (input.streamState !== "connected") {
    return blocked(
      input.streamState === "mock"
        ? "Mock prices are visible, but they are not valid for a trade decision."
        : "Live OANDA pricing is not available.",
    );
  }

  if (!input.marketOpen) {
    return blocked("The forex market is currently closed.");
  }

  if (!input.calendarConnected) {
    return blocked("The economic calendar is unavailable, so the news filter cannot clear a trade.");
  }

  if (
    input.highImpactNewsWithinMinutes !== null &&
    input.highImpactNewsWithinMinutes <= 30
  ) {
    return blocked("High-impact news is inside the 30-minute entry buffer.");
  }

  const maxSpreadPips = input.maxSpreadPips ?? 1.5;
  if (!spreadWithinLimit(input.spreadPips, maxSpreadPips)) {
    return blocked(
      input.spreadPips === null
        ? "A live spread is required before trading."
        : `Spread is ${input.spreadPips.toFixed(1)} pips; the limit is ${maxSpreadPips.toFixed(1)} pips.`,
    );
  }

  if (!input.setupValid) {
    return blocked("No verified strategy setup is available.");
  }

  return {
    permission: "allowed",
    label: "Trading Allowed",
    reason: "Live pricing is available and today’s risk limits are clear.",
  };
}

export function calculateTradeResultR({
  direction,
  entry,
  stop,
  exit,
}: {
  direction: "long" | "short";
  entry: number;
  stop: number;
  exit: number;
}) {
  if (
    !hasPositiveFiniteValues([entry, stop, exit]) ||
    entry === stop
  ) {
    return null;
  }

  const risk = Math.abs(entry - stop);
  const reward = direction === "long" ? exit - entry : entry - exit;
  return reward / risk;
}
