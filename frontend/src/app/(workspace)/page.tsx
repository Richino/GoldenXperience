import {
  DashboardView,
  type DashboardJournal,
  type DashboardOverview,
  type DashboardSavedSetup,
  type DashboardWatchRow,
} from "@/components/dashboard/dashboard-view";
import { getApiData } from "@/lib/api/server";
import { currentTradingDayKey } from "@/lib/format/datetime";
import type { AccountBalanceHistoryPoint, AccountSummary } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

export default async function DashboardPage() {
  // Open manual positions live in Journal and pending entries live in their own
  // endpoint. Fetch them with the rest of Home so these cards do not arrive a
  // beat after the overview snapshot during client hydration.
  const [account, accountHistory, watchlist, savedSetups, overview, journal, pendingEntries] = await Promise.all([
    getApiData<{ data: AccountSummary }>("/api/oanda/account-summary"),
    getApiData<{ data: AccountBalanceHistoryPoint[] }>("/api/oanda/account-history"),
    getApiData<{ watchlist: DashboardWatchRow[] }>("/api/watchlist"),
    getApiData<{ setups: DashboardSavedSetup[] }>("/api/saved-setups"),
    getApiData<DashboardOverview>("/api/paper-cycle"),
    // These enhance the overview rather than block the full Home route during
    // a temporary Journal or pending-entry outage.
    getApiData<DashboardJournal>("/api/journal/trades?limit=50&filter=all").catch(
      () => ({ trades: [] }),
    ),
    getApiData<{ entries?: PendingManualEntry[] }>("/api/pending-entries").catch(
      () => ({ entries: [] }),
    ),
  ]);

  return (
    <DashboardView
      initialAccount={account.data}
      initialAccountHistory={accountHistory.data}
      initialWatchlist={watchlist.watchlist}
      initialSavedSetups={savedSetups.setups ?? []}
      initialOverview={overview}
      initialJournal={journal}
      initialPendingEntries={pendingEntries.entries ?? []}
      userLabel="Richie"
      todayKey={currentTradingDayKey()}
    />
  );
}
