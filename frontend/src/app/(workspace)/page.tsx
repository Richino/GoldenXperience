import { DashboardView, type DashboardOverview, type DashboardSavedSetup, type DashboardWatchRow } from "@/components/dashboard/dashboard-view";
import { getApiData } from "@/lib/api/server";
import { currentTradingDayKey } from "@/lib/format/datetime";
import type { AccountSummary } from "@/types/forex";

export default async function DashboardPage() {
  const [account, accountHistory, watchlist, savedSetups, overview] = await Promise.all([
    getApiData<{ data: AccountSummary }>("/api/oanda/account-summary"),
    getApiData<{ data: import("@/types/forex").AccountBalanceHistoryPoint[] }>("/api/oanda/account-history"),
    getApiData<{ watchlist: DashboardWatchRow[] }>("/api/watchlist"),
    getApiData<{ setups: DashboardSavedSetup[] }>("/api/saved-setups"),
    getApiData<DashboardOverview>("/api/paper-cycle"),
  ]);

  return (
    <DashboardView
      initialAccount={account.data}
      initialAccountHistory={accountHistory.data}
      initialWatchlist={watchlist.watchlist}
      initialSavedSetups={savedSetups.setups ?? []}
      initialOverview={overview}
      initialJournal={{ trades: [] }}
      userLabel="Richie"
      todayKey={currentTradingDayKey()}
    />
  );
}
