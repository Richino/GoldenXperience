import { AppShell } from "@/components/layout/app-shell";
import { redirect } from "next/navigation";
import { getApiData } from "@/lib/api/server";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try { await getApiData("/api/auth/me"); } catch { redirect("/login"); }
  return <AppShell>{children}</AppShell>;
}
