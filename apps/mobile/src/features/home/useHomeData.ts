import { useCallback } from "react";
import {
  getAccountHistory,
  getAccountSummary,
  getJournalTrades,
  getPaperCycle,
  getStrategyWatchlist,
  getWatchlist,
} from "@/api/endpoints";
import { useResource } from "@/hooks/useResource";
import type {
  AccountBalanceHistoryPoint,
  AccountSummary,
  ConnectionStatus,
  JournalResponse,
  OverviewTrade,
  StrategyRow,
  WatchRow,
} from "@/types/api";
import type { JournalTrade } from "@/types/forex";

export interface HomeData {
  account: AccountSummary;
  connection: ConnectionStatus;
  history: AccountBalanceHistoryPoint[];
  watchlist: WatchRow[];
  strategyRows: StrategyRow[];
  openTrades: OverviewTrade[];
  journal: JournalTrade[];
  summary: JournalResponse["summary"];
}

/**
 * Loads everything Home needs in one pass. The account, watchlist, cycle and
 * journal are load-bearing — if they fail the screen shows an error/last data.
 * The balance history and strategy watchlist are best-effort (settled), so a
 * hiccup there never tears down the page.
 */
export function useHomeData() {
  const loader = useCallback(async (signal: AbortSignal): Promise<HomeData> => {
    const [account, watchlist, cycle, journal] = await Promise.all([
      getAccountSummary(signal),
      getWatchlist(signal),
      getPaperCycle(signal),
      getJournalTrades({ limit: 50, filter: "all" }, signal),
    ]);
    const [historyResult, strategyResult] = await Promise.allSettled([
      getAccountHistory(signal),
      getStrategyWatchlist(signal),
    ]);

    const openTrades =
      cycle.openTrades ?? cycle.trades.filter((trade) => trade.status === "open");

    return {
      account: account.data,
      connection: account.status,
      history: historyResult.status === "fulfilled" ? historyResult.value.data : [],
      watchlist: watchlist.watchlist,
      strategyRows: strategyResult.status === "fulfilled" ? strategyResult.value.instruments : [],
      openTrades,
      journal: journal.trades,
      summary: journal.summary,
    };
  }, []);

  return useResource(loader, { intervalMs: 30_000 });
}

/**
 * Marks an open trade to the live market. Never invents a value: falls back to
 * a stored P/L, then to a risk-amount-scaled R computed from a live mid, and
 * finally to null (rendered as "Open") — never a fake $0.00 (brief §14).
 */
export function markOpenTrade(
  trade: OverviewTrade,
  mid: number | null,
): { money: number | null; openR: number | null } {
  if (trade.paperPl !== null && trade.paperPl !== undefined) {
    const openR = trade.nominalRiskAmount ? trade.paperPl / trade.nominalRiskAmount : null;
    return { money: trade.paperPl, openR };
  }
  if (mid === null || trade.entry == null || trade.stop == null || trade.entry === trade.stop) {
    return { money: null, openR: null };
  }
  const openR =
    ((mid - trade.entry) / Math.abs(trade.entry - trade.stop)) * (trade.direction === "long" ? 1 : -1);
  const money = trade.nominalRiskAmount ? openR * trade.nominalRiskAmount : null;
  return { money, openR };
}
