"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { verifiedAccountSummary } from "@/lib/account-summary";
import { formatTradePL } from "@/lib/format/trade-pl";
import { chartTargetPL, chartTradePL, chartTradePLColor } from "@/lib/market-stream/chart-trade-pl";
import { useOpenPositionSnapshot } from "@/lib/market-stream/use-open-positions";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

/** Rebase from the broker periodically, then mark from the chart's own tick. */
export function useChartTradePL(brokerTradeId: string | null, instrument: string, direction: "long" | "short" | null, quote: { bid: number; ask: number } | null, target: number | null) {
  const enabled = brokerTradeId !== null;
  const { fills } = useOpenPositionSnapshot(enabled);
  const [currency, setCurrency] = useState<string | null>(null);
  const loadCurrency = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch(apiUrl("/api/oanda/account-summary"), {
        credentials: "include", cache: "no-store", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return;
      const payload = await response.json() as { data?: AccountSummary; status?: ConnectionStatus };
      const account = verifiedAccountSummary(payload);
      if (account) setCurrency(account.currency);
    } catch {
      // Without verified account currency, show an unavailable amount.
    }
  }, [enabled]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- asynchronous broker read
    void loadCurrency();
  }, [loadCurrency]);
  useForegroundRefresh(loadCurrency);

  // Never use the instrument alias: several fills can share a pair.
  const fill = brokerTradeId ? fills[`broker:${brokerTradeId}`] : undefined;
  const amount = chartTradePL(fill, instrument, direction, currency, quote);
  const targetAmount = chartTargetPL(fill, instrument, direction, currency, target);
  return {
    label: formatTradePL(amount, currency), color: chartTradePLColor(currency ? amount : null),
    targetLabel: formatTradePL(targetAmount, currency).replace(/^P\/L /, "TP "),
  };
}
