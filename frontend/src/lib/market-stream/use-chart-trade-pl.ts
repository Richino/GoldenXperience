"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { verifiedAccountSummary } from "@/lib/account-summary";
import { formatTradePL } from "@/lib/format/trade-pl";
import { useOpenPositionSnapshot } from "@/lib/market-stream/use-open-positions";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

/** Same broker cash value and refresh cadence as Home, for this exact trade. */
export function useChartTradePL(brokerTradeId: string | null) {
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
  return formatTradePL(fill?.unrealizedPL, currency);
}
