import { HomeLoadingSkeleton } from "@/components/ui/home-loading-skeleton";
import { ChartLoadingSkeleton } from "@/components/ui/chart-loading-skeleton";
import {
  LedgerMarketsLoadingSkeleton,
  LedgerSettingsLoadingSkeleton,
  LedgerTradesLoadingSkeleton,
  LedgerWatchlistPairsSkeleton,
} from "@/components/ui/ledger-loading-skeletons";

function Bone({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`gx-skel max-w-full rounded-2xl ${className}`}
    />
  );
}

function Line({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`gx-skel max-w-full rounded-full ${className}`}
    />
  );
}

function PageTitleSkeleton({
  titleWidth = "w-36",
  subtitleWidth = "w-48",
}: {
  titleWidth?: string;
  subtitleWidth?: string;
}) {
  return (
    <div className="min-w-0">
      <Line className={`h-8 ${titleWidth} lg:h-9`} />
      <Line className={`mt-1 h-4 ${subtitleWidth}`} />
    </div>
  );
}

export function WatchlistPairsSkeleton({ rows = 10 }: { rows?: number }) {
  return <LedgerWatchlistPairsSkeleton rows={rows} />;
}

export function WatchlistTabChipsSkeleton() {
  return (
    <div className="binary-seg flex gap-1.5" aria-hidden>
      <Bone className="h-8 w-[5.25rem] rounded-full" />
      <Bone className="h-8 w-[3.9rem] rounded-full" />
    </div>
  );
}

export function JournalEntriesSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="journal-entry-list mt-3">
      {Array.from({ length: rows }, (_, index) => (
        <article key={index} className="journal-entry">
          <div className="journal-entry-head">
            <div className="journal-entry-main min-w-0">
              <div className="flex items-center gap-2">
                <Line className="h-4 w-20" />
                <Line className="h-3 w-10" />
                <Bone className="h-4 w-14 rounded-full" />
              </div>
              <Line className="mt-2 h-3 w-44" />
            </div>
            <div className="journal-entry-aside">
              <div className="journal-entry-result">
                <Line className="h-4 w-14" />
                <Line className="h-3 w-16" />
              </div>
            </div>
          </div>
          <div className="journal-entry-levels">
            {Array.from({ length: 4 }, (_, level) => (
              <div key={level} className="journal-entry-level">
                <Line className="h-2.5 w-8" />
                <Line className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

export function ResearchPaperCycleSkeleton() {
  return (
    <>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Line className="h-4 w-24" />
          <Line className="h-3 w-48" />
          <Line className="h-3 w-56" />
        </div>
        <Line className="h-8 w-16" />
      </div>
      <Bone className="mt-3 h-1.5 w-full rounded-full" />
      <div className="research-metric-grid mt-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="research-metric-cell space-y-2">
            <Line className="h-3 w-16" />
            <Line className="h-6 w-12" />
          </div>
        ))}
      </div>
    </>
  );
}

function ResearchMetricGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="research-metric-grid mt-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="research-metric-cell space-y-2">
          <Line className="h-3 w-16" />
          <Line className="h-6 w-14" />
        </div>
      ))}
    </div>
  );
}

export function DashboardLoadingSkeleton() {
  return <HomeLoadingSkeleton />;
}

export function SignalsLoadingSkeleton() {
  return <ChartLoadingSkeleton />;
}

export function JournalLoadingSkeleton() {
  return <LedgerTradesLoadingSkeleton />;
}

export function WatchlistLoadingSkeleton() {
  return <LedgerMarketsLoadingSkeleton />;
}

export function RiskLoadingSkeleton() {
  return <LedgerSettingsLoadingSkeleton />;
}

export function SettingsLoadingSkeleton() {
  return <LedgerSettingsLoadingSkeleton />;
}

export function ResearchLoadingSkeleton() {
  return (
    <div className="research-view research-minimal space-y-8 lg:space-y-10" aria-busy aria-label="Loading research">
      <header>
        <PageTitleSkeleton titleWidth="w-36" subtitleWidth="w-44" />
      </header>

      <section className="research-minimal-section">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="space-y-1.5">
            <Line className="h-4 w-24" />
            <Line className="h-3 w-40" />
          </div>
          <Line className="h-3 w-16" />
        </div>
        <ResearchPaperCycleSkeleton />
      </section>

      <section className="research-minimal-section">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <Line className="h-4 w-28" />
          <div className="research-toolbar">
            <Bone className="h-9 w-24 rounded-[10px]" />
            <Bone className="h-9 w-36 rounded-[10px]" />
            <Bone className="h-9 w-44 rounded-[10px]" />
          </div>
        </div>
      </section>

      <section className="research-minimal-section">
        <Line className="h-4 w-40" />
        <ResearchMetricGridSkeleton />
        <Line className="mt-3 h-3 w-full" />
      </section>
      {Array.from({ length: 2 }, (_, section) => (
        <section className="research-minimal-section" key={section} aria-hidden="true">
          <Line className="h-4 w-40" />
          <div className="research-compare-grid">
            {Array.from({ length: 5 }, (_, index) => (
              <div className="research-compare-item space-y-3" key={index}>
                <Line className="h-3 w-20" />
                <Line className="h-4 w-full" />
                <Line className="h-4 w-full" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
