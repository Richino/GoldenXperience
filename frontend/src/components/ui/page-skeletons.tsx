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

export function BinaryJournalLoadingSkeleton() {
  return (
    <div className="journal-view space-y-6" aria-busy aria-label="Loading binary prediction journal">
      <section className="journal-stats-card journal-stats-card--quad" aria-hidden>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="journal-stat min-w-0 space-y-2">
            <Line className="h-3 w-12" />
            <Line className="h-6 w-14" />
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section" aria-hidden>
        <Line className="h-4 w-32" />
        <div className="binary-horizon-grid mt-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="binary-horizon-cell">
              <Line className="h-2.5 w-7" />
              <Line className="mt-2 h-7 w-12" />
              <div className="binary-horizon-split">
                {Array.from({ length: 3 }, (_, split) => (
                  <div key={split} className="space-y-1.5">
                    <Line className="h-2 w-4" />
                    <Line className="h-3 w-7" />
                  </div>
                ))}
              </div>
              <Line className="mt-3 h-2.5 w-16" />
            </div>
          ))}
        </div>
      </section>

      <section className="dashboard-minimal-section" aria-hidden>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <Line className="h-4 w-24" />
          <div className="flex flex-wrap gap-1.5">
            {["w-10", "w-16", "w-16", "w-px", "w-10", "w-12", "w-12", "w-10", "w-[4.25rem]"].map((width, index) => (
              <Bone key={index} className={`h-7 ${width} rounded-full`} />
            ))}
          </div>
        </div>

        <div className="journal-entry-list mt-3">
          {Array.from({ length: 5 }, (_, index) => (
            <article key={index} className="journal-entry binary-journal-entry">
              <div className="binary-entry-row">
                <div className="binary-entry-head">
                  <div className="binary-entry-main min-w-0">
                    <div className="flex items-center gap-2">
                      <Line className="h-4 w-20" />
                      <Line className="h-3 w-7" />
                      <Bone className="h-4 w-14 rounded-full" />
                    </div>
                    <Line className="mt-2 h-3 w-40" />
                  </div>
                  <div className="binary-entry-aside gap-1.5">
                    <Line className="h-4 w-10" />
                    <Line className="h-3 w-7" />
                  </div>
                </div>
                <Bone className="binary-entry-expand h-3 w-3 rounded-full" />
              </div>
            </article>
          ))}
        </div>
      </section>
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
    <div className="dashboard-view dashboard-minimal home-shell" aria-busy aria-label="Loading dashboard">
      <div className="home-main">
        <section className="account-overview-hero" aria-hidden>
          <header className="home-hero-topbar lg:hidden">
            <div className="home-hero-topbar-end">
              <Bone className="h-6 w-28 rounded-full" />
              <Bone className="size-9 rounded-full" />
            </div>
          </header>

          <div className="home-hero-head mt-6 lg:mt-0">
            <div className="home-hero-copy">
              <Line className="h-3 w-24" />
              <Line className="mt-3 h-10 w-56 lg:h-12 lg:w-64" />
              <Line className="mt-3 h-4 w-40" />
            </div>
            <div className="home-hero-range account-range-row">
              {Array.from({ length: 5 }, (_, index) => (
                <Bone key={index} className="h-7 w-9 rounded-md" />
              ))}
            </div>
          </div>

          <div className="account-chart mt-5 lg:mt-7">
            <Bone className="account-chart-canvas rounded-none" />
          </div>
          <div className="home-chart-stats">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Line className="h-3 w-16" />
                <Line className="h-4 w-20" />
              </div>
            ))}
          </div>
        </section>

        <section className="home-idle-section" aria-hidden>
          <div className="home-section-head">
            <Line className="h-3 w-14" />
            <Line className="h-3 w-10" />
          </div>
          <Line className="mt-4 h-5 w-48" />
        </section>

        <div className="dashboard-minimal-grid dashboard-trades-grid">
          <section className="home-section" aria-hidden>
            <div className="home-section-head">
              <Line className="h-3 w-24" />
              <Line className="h-3 w-12" />
            </div>
            <div className="home-position-list">
              <div className="home-position-row">
                <div className="space-y-2"><Line className="h-4 w-24" /><Line className="h-3 w-36" /></div>
                <div className="space-y-2"><Line className="ml-auto h-4 w-16" /><Line className="ml-auto h-3 w-10" /></div>
              </div>
            </div>
          </section>
        </div>

        <section className="home-section" aria-hidden>
          <div className="home-section-head">
            <Line className="h-3 w-24" />
            <Line className="h-3 w-12" />
          </div>
          <div className="home-signal-card mt-4 space-y-3 p-3">
            <div className="flex justify-between gap-3"><Line className="h-4 w-20" /><Line className="h-4 w-12" /></div>
            <div className="grid grid-cols-3 gap-3"><Line className="h-3 w-full" /><Line className="h-3 w-full" /><Line className="h-3 w-full" /></div>
            <Line className="h-3 w-16" />
          </div>
        </section>

        <section className="home-section" aria-hidden>
          <div className="home-section-head"><Line className="h-3 w-20" /></div>
          <div className="mt-4 grid grid-cols-3 gap-3"><Line className="h-4 w-full" /><Line className="h-4 w-full" /><Line className="h-4 w-full" /></div>
        </section>

        <section className="home-idle-section" aria-hidden>
          <div className="home-section-head">
            <Line className="h-3 w-28" />
            <Line className="h-3 w-12" />
          </div>
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }, (_, index) => <Line key={index} className="h-4 w-full" />)}
          </div>
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
            <div className="signals-mobile-content">
              <div className="signals-mobile-actions flex items-center justify-between">
                <Bone className="h-[2.35rem] w-[7.1rem] rounded-full" />
                <Bone className="size-10 rounded-full" />
              </div>
              <div className="gx-mobile-quote-row">
                <Line className="h-8 w-28" />
                <Line className="h-4 w-20" />
              </div>
              <div className="gx-mobile-timeframes">
                <Bone className="h-[2.6rem] w-full rounded-[10px]" />
              </div>
            </div>
            <div className="relative min-h-[14rem] flex-1 overflow-hidden chart-data-shell chart-loading-static">
              <ChartPlotSkeleton />
            </div>
            <div className="gx-mobile-chart-toolbar px-3 py-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Bone key={index} className="h-full w-full rounded-xl" />
              ))}
            </div>
            <div className="gx-mobile-position-section">
              <Bone className="h-11 w-full rounded-xl" />
            </div>
            <dl className="gx-mobile-market-strip">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="space-y-1.5">
                  <Line className="h-2 w-8" />
                  <Line className="h-3 w-10" />
                </div>
              ))}
            </dl>
          </div>

          <div className="signals-chart-desktop hidden lg:grid gx-chart-terminal">
            <div className="signals-chart-head">
              <div className="signals-chart-head-main">
                <Line className="h-4 w-16" />
                <div className="signals-chart-quote space-y-1">
                  <Line className="h-4 w-20" />
                  <Line className="h-3 w-16" />
                </div>
              </div>
              <div className="signals-chart-head-tools">
                <Bone className="h-7 w-20 rounded-md" />
                <Bone className="h-7 w-24 rounded-md" />
                <Bone className="size-7 rounded-md" />
                <Bone className="size-7 rounded-md" />
              </div>
            </div>
            <div className="gx-chart-stage">
              <div className="signals-chart-canvas chart-loading-static min-h-[24rem] flex-1">
                <ChartPlotSkeleton />
              </div>
            </div>
            <div className="gx-active-position gx-active-position-empty">
              <Line className="h-3 w-40" />
            </div>
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
        <Line className="h-8 w-28 lg:h-9" />
        <div className="binary-seg journal-mode-tabs mt-3" aria-hidden>
          <Bone className="h-8 w-16 rounded-full" />
          <Bone className="h-8 w-32 rounded-full" />
        </div>
      </header>

      <section className="journal-stats-card">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="journal-stat min-w-0 space-y-2">
            <Line className="h-3 w-12" />
            <Line className="h-6 w-14" />
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section">
        <div className="journal-log-header">
          <Line className="h-4 w-20" />
          <div className="journal-log-filters">
            {["w-10", "w-12", "w-[4.25rem]", "w-[4.25rem]"].map((width, index) => (
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
    <div className="watchlist-tabs space-y-6" aria-busy aria-label="Loading watchlist">
      <WatchlistTabChipsSkeleton />
      <div className="ms-view space-y-8 lg:space-y-10">
        <header>
          <Line className="h-8 w-32 lg:h-9" />
        </header>
        <StrategiesWatchlistSkeleton />
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
          {Array.from({ length: 3 }, (_, index) => (
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

      <section className="settings-minimal-section">
        <Line className="h-4 w-10" />
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Line className="h-3 w-20" />
              <Bone className="h-10 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </section>

      <section className="settings-minimal-section">
        <div className="settings-row">
          <Line className="h-4 w-28" />
          <Bone className="h-10 w-20 rounded-xl" />
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
import { ChartPlotSkeleton } from "@/components/charts/chart-loading-overlay";
