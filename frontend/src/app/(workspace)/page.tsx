import { DashboardView, type DashboardExposure, type DashboardOverview, type DashboardWatchRow } from "@/components/dashboard/dashboard-view";
import { getApiData } from "@/lib/api/server";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

export default async function DashboardPage() {
  const [account, watchlist, overview, risk] = await Promise.all([
    getApiData<{ data: AccountSummary; status: ConnectionStatus }>("/api/oanda/account-summary"),
    getApiData<{ watchlist: DashboardWatchRow[] }>("/api/watchlist"),
    getApiData<DashboardOverview>("/api/paper-cycle"),
    getApiData<{ exposure: DashboardExposure }>("/api/paper-risk"),
  ]);

  return (
    <DashboardView
      initialStatus={account.status}
      initialAccount={account.data}
      initialWatchlist={watchlist.watchlist}
      initialOverview={overview}
      initialExposure={risk.exposure}
      userLabel="Richie"
    />
  );
}
