import type { Metadata } from "next";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { type PaperRiskPolicy } from "@/components/risk/risk-workspace";
import { getApiData } from "@/lib/api/server";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const riskResult = await getApiData<{ policy: PaperRiskPolicy }>("/api/paper-risk");

  return (
    <SettingsPanel initialPolicy={riskResult.policy} />
  );
}
