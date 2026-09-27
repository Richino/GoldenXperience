import type { Metadata } from "next";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { type PaperRiskPolicy } from "@/components/risk/risk-workspace";
import { getApiData } from "@/lib/api/server";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const [riskResult, account] = await Promise.all([
    getApiData<{ policy: PaperRiskPolicy }>("/api/paper-risk"),
    // Only feeds the phone "Signed in as" row; the page still renders without it.
    getApiData<{ user: { email: string } }>("/api/auth/me").catch(() => null),
  ]);

  return (
    <SettingsPanel initialPolicy={riskResult.policy} email={account?.user.email ?? null} />
  );
}
