import type { Metadata } from "next";
import { RiskWorkspace, type PaperExposure, type PaperRiskPolicy } from "@/components/risk/risk-workspace";
import { PageHeader } from "@/components/ui/page-header";
import { getApiData } from "@/lib/api/server";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

export const metadata: Metadata = {
  title: "Risk",
};

export default async function RiskPage() {
  const [accountResult, riskResult] = await Promise.all([
    getApiData<{ data: AccountSummary; status: ConnectionStatus }>("/api/oanda/account-summary"),
    getApiData<{ exposure: PaperExposure; policy: PaperRiskPolicy }>("/api/paper-risk"),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Research exposure"
        title="Paper risk"
        description="Measure the exposure actually created by automatic ten-pair collection, without pretending it is a live portfolio risk model."
      />
      <RiskWorkspace
        initialAccount={accountResult.data}
        initialStatus={accountResult.status}
        initialExposure={riskResult.exposure}
        initialPolicy={riskResult.policy}
      />
    </>
  );
}
