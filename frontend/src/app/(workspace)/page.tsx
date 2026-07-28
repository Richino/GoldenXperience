import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";

export default async function DashboardPage() {
  const snapshot = await getApiData<StrategySnapshot>("/api/strategy");

  return (
    <DashboardView
      status={snapshot.accountStatus}
      account={snapshot.account}
      strategy={snapshot.strategy.bestSetup}
    />
  );
}
