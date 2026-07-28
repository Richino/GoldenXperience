import type { Metadata } from "next";
import { connection } from "next/server";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { testOandaConnection } from "@/lib/oanda/client";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  await connection();
  const status = await testOandaConnection();

  return <SettingsPanel initialStatus={status} />;
}
