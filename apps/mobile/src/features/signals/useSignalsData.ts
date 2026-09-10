import { useCallback } from "react";
import { getJournalTrades, getStrategySnapshot, getWatchlist } from "@/api/endpoints";
import { useResource } from "@/hooks/useResource";
import type { StrategySetup, WatchRow } from "@/types/api";
import type { JournalTrade } from "@/types/forex";

export interface SignalsData {
  setups: StrategySetup[];
  plans: Pick<WatchRow, "instrument" | "openTradeId">[];
  journal: JournalTrade[];
}

/** Loads the strategy snapshot, watchlist plans and journal for the Signals tab. */
export function useSignalsData() {
  const loader = useCallback(async (signal: AbortSignal): Promise<SignalsData> => {
    const [snapshot, watchlist, journal] = await Promise.all([
      getStrategySnapshot(signal),
      getWatchlist(signal),
      getJournalTrades({ limit: 50, filter: "all" }, signal),
    ]);
    return {
      setups: snapshot.strategy.setups,
      plans: watchlist.watchlist.map((row) => ({ instrument: row.instrument, openTradeId: row.openTradeId })),
      journal: journal.trades,
    };
  }, []);

  return useResource(loader, { intervalMs: 60_000 });
}
