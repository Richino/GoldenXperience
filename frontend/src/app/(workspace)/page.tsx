import { DashboardView, type DashboardExposure, type DashboardOverview, type DashboardStrategyRow, type DashboardWatchRow } from "@/components/dashboard/dashboard-view";
import { getApiData } from "@/lib/api/server";
import { currentTradingDayKey } from "@/lib/format/datetime";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

export default async function DashboardPage() {
  const [account, accountHistory, watchlist, strategyWatchlist, overview, risk] = await Promise.all([
    getApiData<{ data: AccountSummary; status: ConnectionStatus }>("/api/oanda/account-summary"),
    getApiData<{ data: import("@/types/forex").AccountBalanceHistoryPoint[] }>("/api/oanda/account-history"),
    getApiData<{ watchlist: DashboardWatchRow[] }>("/api/watchlist"),
    getApiData<{ instruments: DashboardStrategyRow[] }>("/api/multistrategy/watchlist"),
    getApiData<DashboardOverview>("/api/paper-cycle"),
    getApiData<{ exposure: DashboardExposure }>("/api/paper-risk"),
  ]);

  return (
    <DashboardView
      initialStatus={account.status}
      initialAccount={account.data}
      initialAccountHistory={accountHistory.data}
      initialWatchlist={watchlist.watchlist}
      initialStrategyWatchlist={strategyWatchlist.instruments}
      initialOverview={overview}
      initialExposure={risk.exposure}
      userLabel="Richie"
      todayKey={currentTradingDayKey()}
    />
  );
}
