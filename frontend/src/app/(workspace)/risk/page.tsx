import type { Metadata } from "next";
import { RiskWorkspace } from "@/components/risk/risk-workspace";
import { PageHeader } from "@/components/ui/page-header";
import { getApiData } from "@/lib/api/server";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

export const metadata: Metadata = {
  title: "Risk",
};

export default async function RiskPage() {
  const accountResult = await getApiData<{ data: AccountSummary; status: ConnectionStatus }>("/api/oanda/account-summary");

  return (
    <>
      <PageHeader
        eyebrow="Capital protection"
        title="Risk plan"
        description="Size every setup from its stop, then let the daily limits decide whether another trade is allowed."
      />
      <RiskWorkspace
        account={accountResult.data}
        status={accountResult.status}
      />
    </>
  );
}
