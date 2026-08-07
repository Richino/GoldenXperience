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

export function getPipValuePerStandardLot(
  instrument: MajorInstrument,
  price: number,
) {
  if (!Number.isFinite(price) || price <= 0) return 0;

  // For a USD-denominated account, a standard lot of a USD-quoted pair is
  // always $10/pip. When the quote currency is not USD the pip value has to be
  // converted through the pair's own price.
  const { quote } = currenciesOf(instrument);
  if (quote === "USD") return 10;

  return (pipSizeFor(instrument) * 100_000) / price;
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
