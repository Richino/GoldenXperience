"use client";

import { useCallback } from "react";
import { formatTradePL } from "@/lib/format/trade-pl";
import { currenciesOf } from "@/lib/instruments/catalog";
import { chartTargetPL, chartTradePLColor } from "@/lib/market-stream/chart-trade-pl";
import { useOpenPositionSnapshot } from "@/lib/market-stream/use-open-positions";

/**
 * What a resting order books at a level once it fills at its own entry price,
 * from the units it was placed with. Returns null for a level it cannot price
 * (no size yet, or no conversion for a non-account-currency pair).
 */
export function usePendingExitPL(instrument: string, direction: "long" | "short" | null, entryPrice: number | null, units: number | null) {
  const sized = direction !== null && entryPrice !== null && units !== null && Number.isFinite(units) && units > 0;
  const { currency, homeConversions } = useOpenPositionSnapshot(sized);
  const conversion = homeConversions[currenciesOf(instrument).quote];
  return useCallback((price: number | null) => {
    if (!sized) return null;
    const amount = chartTargetPL({ price: entryPrice, units: Math.abs(units) }, instrument, direction, currency, price, conversion);
    const label = formatTradePL(amount, currency).slice("P/L ".length);
    return label === "—" ? null : label;
  }, [sized, entryPrice, units, instrument, direction, currency, conversion]);
}

/** Use the selected trade's reported P/L from the account snapshot. */
export function useChartTradePL(brokerTradeId: string | null, instrument: string, direction: "long" | "short" | null, target: number | null, stop: number | null = null) {
  const { fills, currency, homeConversions } = useOpenPositionSnapshot(brokerTradeId !== null);

  // Never use the instrument alias: several fills can share a pair.
  const fill = brokerTradeId ? fills[`broker:${brokerTradeId}`] : undefined;
  const amount = fill && Number.isFinite(fill.unrealizedPL) ? fill.unrealizedPL : null;
  const conversion = homeConversions[currenciesOf(instrument).quote];
  const formatExitPL = useCallback((price: number | null) => (
    formatTradePL(chartTargetPL(fill, instrument, direction, currency, price, conversion), currency).slice("P/L ".length)
  ), [fill, instrument, direction, currency, conversion]);
  const targetAmountLabel = formatExitPL(target);
  // What the trade books if the stop fills: a loss below entry, locked-in
  // profit once the stop has moved past it. Null until the amount is known.
  const stopAmountLabel = formatExitPL(stop);
  return {
    label: formatTradePL(amount, currency), color: chartTradePLColor(currency ? amount : null),
    targetLabel: `TP ${targetAmountLabel}`,
    stopAmountLabel: stopAmountLabel === "—" ? null : stopAmountLabel,
    formatExitPL,
  };
}
