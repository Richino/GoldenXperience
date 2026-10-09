import {
  DashboardView,
  type DashboardJournal,
  type DashboardOverview,
  type DashboardSavedSetup,
  type DashboardWatchRow,
} from "@/components/dashboard/dashboard-view";
import { getApiData } from "@/lib/api/server";
import { verifiedAccountSummary } from "@/lib/account-summary";
import { currentTradingDayKey } from "@/lib/format/datetime";
import type { AccountBalanceHistoryPoint, AccountSummary, ConnectionStatus } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";
import type { MorningPicksSnapshot } from "@/lib/strategy/morning-scan";

/**
 * Worked out here rather than in the browser so the server render and
 * hydration agree; the trading day runs on New York time, so the greeting does.
 */
function greetingFor(name: string, now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/New_York" }).format(now),
  );
  const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  return `${part}, ${name}`;
}

export default async function DashboardPage() {
  // Open manual positions live in Journal and pending entries live in their own
  // endpoint. Fetch them with the rest of Home so these cards do not arrive a
  // beat after the overview snapshot during client hydration.
  const [account, accountHistory, watchlist, savedSetups, overview, journal, pendingEntries, morningPicks] = await Promise.all([
    getApiData<{ data: AccountSummary; status?: ConnectionStatus }>("/api/oanda/account-summary").catch(() => ({ data: null })),
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
    getApiData<MorningPicksSnapshot>("/api/morning-picks").catch(() => null),
  ]);

  return (
    <DashboardView
      initialAccount={verifiedAccountSummary(account)}
      initialAccountHistory={accountHistory.data}
      initialWatchlist={watchlist.watchlist}
      initialSavedSetups={savedSetups.setups ?? []}
      initialOverview={overview}
      initialJournal={journal}
      initialPendingEntries={pendingEntries.entries ?? []}
      initialMorningPicks={morningPicks}
      greeting={greetingFor("Richie")}
      todayKey={currentTradingDayKey()}
    />
  );
}
