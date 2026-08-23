function Bone({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-2xl bg-[color:var(--surface-raised)] ${className}`}
    />
  );
}

function Line({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-full bg-[color:var(--surface-raised)] ${className}`}
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

function WatchlistRowSkeleton() {
  return (
    <div className="dashboard-minimal-row block py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Line className="h-4 w-24" />
          <Line className="h-3 w-20" />
        </div>
        <div className="shrink-0 space-y-2">
          <Line className="ml-auto h-4 w-16" />
          <Line className="ml-auto h-3 w-20" />
        </div>
      </div>
      <Bone className="mt-2 h-1 w-full rounded-full" />
    </div>
  );
}

export function WatchlistPairsSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="wl-pairs mt-3" data-wl-layout="detail">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="wl-pair-card">
          <div className="wl-main min-w-0">
            <div className="wl-pair">
              <Line className="h-4 w-28" />
              <Bone className="h-4 w-10 rounded-full" />
            </div>
            <div className="wl-detail">
              <Line className="h-3 w-32" />
              <div className="wl-levels-grid mt-2">
                {Array.from({ length: 3 }, (_, level) => (
                  <div key={level} className="wl-level space-y-1.5">
                    <Line className="h-2.5 w-10" />
                    <Line className="h-4 w-16" />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="wl-aside">
            <Line className="ml-auto h-4 w-32" />
            <Line className="ml-auto mt-1.5 h-3 w-24" />
          </div>
          <div className="wl-checklist-progress">
            <span className="animate-pulse bg-[color:var(--surface-raised)]" style={{ width: "40%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function WatchlistTabChipsSkeleton() {
  return (
    <div className="binary-seg flex gap-1.5" aria-hidden>
      <Bone className="h-8 w-[5.25rem] rounded-full" />
      <Bone className="h-8 w-[3.9rem] rounded-full" />
    </div>
  );
}

export function StrategiesWatchlistSkeleton() {
  return (
    <div className="ms-view space-y-8" aria-busy aria-label="Loading strategies">
      <section className="dashboard-minimal-section">
        <Line className="h-4 w-16" />
        <div className="ms-family-list mt-3">
          {Array.from({ length: 4 }, (_, index) => (
            <article key={index} className="ms-family-card">
              <div className="ms-family-head">
                <div className="min-w-0 space-y-2">
                  <Line className="h-4 w-24" />
                  <Line className="h-3 w-36" />
                </div>
                <div className="space-y-2">
                  <Line className="ml-auto h-6 w-12" />
                  <Line className="ml-auto h-3 w-14" />
                </div>
              </div>
              <Line className="mt-4 h-3 w-28" />
            </article>
          ))}
        </div>
      </section>
      <section className="dashboard-minimal-section">
        <div className="flex items-baseline justify-between gap-3">
          <Line className="h-4 w-12" />
          <Line className="h-3 w-6" />
        </div>
        <div className="ms-pair-list mt-3">
          {Array.from({ length: 4 }, (_, index) => (
            <article key={index} className="ms-pair-card">
              <Line className="h-4 w-24" />
              <Line className="mt-2 h-3 w-40" />
              <div className="ms-setup-grid">
                {Array.from({ length: 4 }, (_, cell) => (
                  <div key={cell} className="ms-setup space-y-2">
                    <Line className="h-3 w-16" />
                    <Line className="h-3 w-20" />
                  </div>
                ))}
              </div>
              <Line className="mt-4 h-3 w-48" />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function BinaryWatchlistSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="binary-wl-list" aria-busy aria-label="Loading binary monitor">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="binary-wl-card">
          <div className="binary-wl-top">
            <div className="flex items-center gap-2">
              <Line className="h-4 w-20" />
              <Line className="h-3 w-8" />
            </div>
            <Line className="h-4 w-32" />
          </div>
          <Bone className="binary-wl-meter mt-2" />
          <div className="binary-wl-foot">
            <Line className="h-3 w-36" />
            <Line className="h-3 w-8" />
          </div>
        </div>
      ))}
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
  return (
    <div className="dashboard-view dashboard-minimal space-y-8 lg:space-y-10" aria-busy aria-label="Loading dashboard">
      <section className="account-overview-hero" aria-hidden>
        <header className="flex items-center justify-between gap-3 lg:hidden">
          <div className="flex items-center gap-3">
            <Bone className="size-9 shrink-0 rounded-full" />
            <Line className="h-5 w-28" />
          </div>
          <Bone className="size-9 shrink-0 rounded-full" />
        </header>

        <div className="mt-7 lg:mt-0">
          <Line className="hidden h-4 w-24 lg:block" />
          <Line className="mt-0 h-10 w-52 lg:mt-3 lg:h-12 lg:w-64" />
          <Bone className="mt-3 h-6 w-48 rounded-full" />
        </div>

        <div className="mt-5 lg:mt-7">
          <div className="account-chart">
            <div className="account-range-row">
              {Array.from({ length: 4 }, (_, index) => (
                <Bone key={index} className="h-7 w-10 rounded-full" />
              ))}
              <Line className="ml-1 h-3 w-8" />
            </div>
            <Bone className="account-chart-canvas mt-4 rounded-none" />
            <div className="mt-3 flex items-center justify-between gap-3">
              <Line className="h-3 w-40" />
              <Line className="h-3 w-36" />
            </div>
          </div>
        </div>
      </section>

      <section className="dashboard-minimal-section">
        <div className="grid grid-cols-3 divide-x divide-[color:var(--border)]">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="dashboard-stat min-w-0 space-y-2 px-3 first:pl-0 last:pr-0">
              <Line className="h-3 w-12" />
              <Line className="h-6 w-16 sm:h-7" />
              <Line className="h-3 w-20" />
            </div>
          ))}
        </div>
      </section>

      <section className="dashboard-minimal-section">
        <div className="flex items-baseline justify-between gap-3">
          <Line className="h-4 w-20" />
          <Line className="h-3 w-14" />
        </div>
        <div className="dashboard-watchlist-grid mt-3">
          {Array.from({ length: 9 }, (_, index) => (
            <WatchlistRowSkeleton key={index} />
          ))}
        </div>
      </section>

      <div className="dashboard-minimal-grid">
        <section className="dashboard-minimal-section">
          <div className="flex items-baseline justify-between gap-3">
            <Line className="h-4 w-28" />
            <Line className="h-3 w-14" />
          </div>
          <div className="dash-trade-list mt-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="dash-trade-card">
                <div className="dash-trade-main min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <Line className="h-4 w-24" />
                    <Line className="h-3 w-10" />
                  </div>
                  <Line className="h-3 w-28" />
                </div>
                <div className="dash-trade-aside space-y-1.5">
                  <Line className="ml-auto h-4 w-16" />
                  <Line className="ml-auto h-3 w-12" />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-minimal-actions">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="dashboard-minimal-action">
              <Bone className="size-4 shrink-0 rounded-md" />
              <Line className="h-4 w-32" />
              <Bone className="ml-auto size-3.5 rounded-sm" />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export function SignalsLoadingSkeleton() {
  return (
    <div
      className="signals-view signals-minimal grid w-full gap-5"
      aria-busy
      aria-label="Loading signals"
    >
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full">
          <div className="signals-chart-mobile lg:hidden">
            <div className="signals-mobile-content px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
              <div className="signals-mobile-actions flex items-center justify-between">
                <Bone className="size-10 rounded-full" />
                <div className="flex items-center gap-2">
                  <Bone className="size-10 rounded-full" />
                  <Bone className="size-10 rounded-full" />
                </div>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Bone className="size-9 shrink-0 rounded-full" />
                  <div className="space-y-2">
                    <Line className="h-4 w-20" />
                    <Line className="h-3 w-16" />
                  </div>
                </div>
                <Line className="h-6 w-24" />
              </div>
              <Bone className="mt-3 h-11 w-full rounded-full" />
              <div className="signals-mobile-tools mt-3">
                <Bone className="h-9 w-[4.75rem] rounded-full" />
                <Bone className="h-9 w-14 rounded-full" />
                <Bone className="h-9 w-11 rounded-full" />
                <Bone className="h-9 w-11 rounded-full" />
                <Bone className="h-9 w-11 rounded-full" />
              </div>
            </div>
            <div className="relative min-h-[14rem] flex-1 overflow-hidden chart-data-shell">
              <Bone className="h-full w-full rounded-none" />
            </div>
          </div>

          <div className="signals-chart-desktop hidden lg:flex">
            <div className="signals-chart-head">
              <div className="signals-chart-head-main">
                <Bone className="size-[38px] shrink-0 rounded-full" />
                <div className="space-y-2">
                  <Line className="h-4 w-20" />
                  <Line className="h-3 w-16" />
                </div>
                <div className="signals-chart-quote space-y-1.5">
                  <Line className="h-5 w-24" />
                  <Line className="h-3 w-20" />
                </div>
              </div>
              <div className="signals-chart-head-tools">
                <Bone className="h-9 w-36 rounded-xl" />
                <Bone className="size-9 rounded-[10px]" />
                <Bone className="size-9 rounded-[10px]" />
                <Bone className="size-9 rounded-[10px]" />
                <Bone className="size-9 rounded-[10px]" />
              </div>
            </div>
            <div className="signals-chart-strip">
              {Array.from({ length: 5 }, (_, index) => (
                <Bone key={`tf-${index}`} className="h-8 w-10 rounded-md" />
              ))}
              <span className="signals-chart-strip-divider" />
              {Array.from({ length: 7 }, (_, index) => (
                <Bone key={`range-${index}`} className="h-8 w-10 rounded-md" />
              ))}
            </div>
            <Bone className="signals-chart-canvas h-[680px] rounded-none" />
          </div>
        </section>
      </div>
    </div>
  );
}

export function JournalLoadingSkeleton() {
  return (
    <div className="journal-view journal-minimal space-y-8 lg:space-y-10" aria-busy aria-label="Loading journal">
      <header>
        <PageTitleSkeleton titleWidth="w-28" subtitleWidth="w-32" />
      </header>

      <section className="journal-stats-card grid grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="journal-stat min-w-0 space-y-2">
            <Line className="h-3 w-12" />
            <Line className="h-6 w-14" />
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <Line className="h-4 w-20" />
          <div className="flex flex-wrap gap-1.5">
            {["w-10", "w-12", "w-14", "w-[4.25rem]", "w-[4.25rem]", "w-[4.5rem]"].map((width, index) => (
              <Bone key={index} className={`h-7 ${width} rounded-full`} />
            ))}
          </div>
        </div>
        <JournalEntriesSkeleton />
      </section>
    </div>
  );
}

export function WatchlistLoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading watchlist">
      <WatchlistTabChipsSkeleton />
      <div className="watchlist-view watchlist-minimal space-y-8 lg:space-y-10">
        <header className="flex items-end justify-between gap-4">
          <PageTitleSkeleton titleWidth="w-36" subtitleWidth="w-44" />
          <Bone className="size-10 shrink-0 rounded-full" />
        </header>

        <section className="dashboard-minimal-section">
          <div className="flex items-baseline justify-between gap-3">
            <Line className="h-4 w-12" />
            <Line className="h-3 w-6" />
          </div>
          <WatchlistPairsSkeleton />
        </section>
      </div>
    </div>
  );
}

export function RiskLoadingSkeleton() {
  return (
    <div className="risk-view risk-minimal space-y-8 lg:space-y-10" aria-busy aria-label="Loading risk">
      <header className="flex items-end justify-between gap-4">
        <PageTitleSkeleton titleWidth="w-20" subtitleWidth="w-28" />
        <Bone className="size-10 shrink-0 rounded-full" />
      </header>

      <section className="risk-stats-card">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="risk-stat space-y-2">
            <Line className="h-3 w-12" />
            <Line className="h-6 w-16" />
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <Line className="h-4 w-20" />
          <Line className="h-3 w-16" />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Line className="h-3 w-20" />
              <Bone className="h-11 w-full rounded-xl" />
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Bone className="size-4 rounded-sm" />
            <Line className="h-4 w-32" />
          </div>
          <Bone className="h-10 w-20 rounded-xl" />
        </div>
      </section>

      <div className="dashboard-minimal-grid">
        <section className="dashboard-minimal-section">
          <div className="flex items-baseline justify-between gap-3">
            <Line className="h-4 w-28" />
            <Line className="h-3 w-6" />
          </div>
          <div className="mt-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="dashboard-minimal-row flex items-center justify-between gap-3 py-3">
                <div className="space-y-2">
                  <Line className="h-4 w-28" />
                  <Line className="h-3 w-16" />
                </div>
                <div className="space-y-1.5 text-right">
                  <Line className="ml-auto h-4 w-12" />
                  <Line className="ml-auto h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="dashboard-minimal-section space-y-3">
          <Line className="h-4 w-20" />
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-1.5">
              <div className="flex justify-between">
                <Line className="h-3 w-10" />
                <Line className="h-3 w-12" />
              </div>
              <Bone className="h-1 w-full rounded-full" />
            </div>
          ))}
        </section>
      </div>

      <section className="dashboard-minimal-actions">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="dashboard-minimal-action">
            <Line className="h-4 w-24" />
            <Bone className="ml-auto size-3.5 rounded-sm" />
          </div>
        ))}
      </section>
    </div>
  );
}

export function SettingsLoadingSkeleton() {
  return (
    <div className="settings-view settings-minimal space-y-8 lg:space-y-10" aria-busy aria-label="Loading settings">
      <header>
        <PageTitleSkeleton titleWidth="w-36" subtitleWidth="w-64" />
      </header>

      <section className="settings-minimal-section">
        <Line className="h-4 w-24" />
        <div className="mt-4 space-y-4">
          <div className="settings-row">
            <Line className="h-4 w-14" />
            <div className="settings-segment">
              <Bone className="h-8 w-14 rounded-lg" />
              <Bone className="h-8 w-14 rounded-lg" />
            </div>
          </div>
          <div className="settings-row">
            <Line className="h-4 w-16" />
            <div className="settings-segment">
              <Bone className="h-8 w-9 rounded-lg" />
              <Bone className="h-8 w-9 rounded-lg" />
              <Bone className="h-8 w-9 rounded-lg" />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-minimal-section">
        <Line className="h-4 w-28" />
        <div className="mt-4 space-y-4">
          <div className="settings-row items-end">
            <Line className="h-4 w-14" />
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
              <Bone className="h-11 w-full rounded-xl sm:w-56" />
              <Bone className="h-11 w-24 rounded-xl" />
            </div>
          </div>
          <div className="settings-row items-center">
            <Line className="h-4 w-16" />
            <div className="flex w-full items-center gap-3 sm:w-80">
              <Bone className="size-5 shrink-0 rounded-md" />
              <Bone className="h-2 flex-1 rounded-full" />
              <Line className="h-4 w-10" />
            </div>
          </div>
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="settings-row">
              <div className="space-y-1.5">
                <Line className="h-4 w-28" />
                <Line className="h-3 w-24" />
              </div>
              <Bone className="h-10 w-20 rounded-xl" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
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
    </div>
  );
}
