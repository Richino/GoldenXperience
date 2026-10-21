import { DashboardView } from "@/components/dashboard/dashboard-view";
import { currentTradingDayKey } from "@/lib/format/datetime";

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

export default function DashboardPage() {
  // The workspace layout authenticates this route. Home's existing client
  // subscriptions fetch in parallel behind one coordinated Home skeleton,
  // without a second SSR fan-out.
  return (
    <DashboardView
      initialAccount={null}
      initialAccountHistory={[]}
      initialWatchlist={[]}
      initialSavedSetups={[]}
      initialOverview={null}
      initialJournal={{ trades: [] }}
      initialPendingEntries={[]}
      initialLoading
      greeting={greetingFor("Richie")}
      todayKey={currentTradingDayKey()}
    />
  );
}
