import type { Metadata } from "next";
import { SignalsView } from "@/components/signals/signals-view";
import { getApiData } from "@/lib/api/server";
import { currentTradingDayKey } from "@/lib/format/datetime";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import type { SignalPlan } from "@/lib/signals/build";
import type { JournalTrade } from "@/types/forex";

export const metadata: Metadata = {
  title: "Signals",
};

export default async function SignalsPage() {
  const [snapshot, watchlist, journal] = await Promise.all([
    getApiData<StrategySnapshot>("/api/strategy"),
    getApiData<{ watchlist: SignalPlan[] }>("/api/watchlist"),
    getApiData<{ trades: JournalTrade[] }>("/api/journal/trades?limit=50&filter=all"),
  ]);

  return (
    <SignalsView
      initialSetups={snapshot.strategy.setups}
      initialPlans={watchlist.watchlist}
      initialJournal={{ trades: journal.trades }}
      todayKey={currentTradingDayKey()}
    />
  );
}
