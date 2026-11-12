"use client";

import { useCallback } from "react";
import { formatTradePL } from "@/lib/format/trade-pl";
import { currenciesOf } from "@/lib/instruments/catalog";
import { chartTargetPL, chartTradePLColor } from "@/lib/market-stream/chart-trade-pl";
import { useOpenPositionSnapshot } from "@/lib/market-stream/use-open-positions";

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
