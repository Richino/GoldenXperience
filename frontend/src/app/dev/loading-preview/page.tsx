import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChartLoadingSkeleton } from "@/components/ui/chart-loading-skeleton";

export const metadata: Metadata = { title: "Loading animation preview" };

/** Keep the real chart loader visible so its animation can be reviewed. */
export default function LoadingPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="min-h-dvh p-4 lg:p-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-sm font-medium">Chart loading preview</h1>
        <p className="text-xs text-[var(--muted)]">Loops continuously</p>
      </header>
      <ChartLoadingSkeleton />
    </main>
  );
}
