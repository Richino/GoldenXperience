import type { Metadata } from "next";
import { connection } from "next/server";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { getApiData } from "@/lib/api/server";
import type { ConnectionStatus } from "@/types/forex";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  await connection();
  let status: ConnectionStatus | undefined;
  try {
    const result = await getApiData<{ status: ConnectionStatus }>("/api/oanda/status");
    status = result.status;
  } catch {
    status = undefined;
  }

  return <SettingsPanel initialStatus={status} />;
}
