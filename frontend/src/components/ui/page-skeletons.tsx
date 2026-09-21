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

/** Mirrors the chart pane while price history is still loading. */
function ChartScreenSkeleton() {
  // Dense enough to read like a live chart viewport. Heights/tops are uneven
  // on purpose so the strip doesn't look like a repeating pattern.
  const candles = [
    [61, 14, "down"], [48, 6, "up"], [53, 19, "up"], [57, 4, "down"],
    [41, 16, "down"], [36, 9, "up"], [44, 22, "up"], [55, 5, "down"],
    [62, 11, "down"], [49, 3, "up"], [38, 18, "up"], [33, 7, "down"],
    [29, 13, "down"], [42, 21, "up"], [51, 8, "up"], [58, 15, "down"],
    [64, 4, "down"], [56, 17, "up"], [47, 6, "up"], [39, 20, "down"],
    [34, 10, "down"], [28, 14, "up"], [37, 23, "up"], [46, 5, "down"],
    [54, 12, "down"], [60, 7, "up"], [52, 16, "up"], [43, 9, "down"],
    [35, 19, "down"], [40, 4, "up"], [50, 14, "up"], [59, 8, "down"],
    [66, 11, "down"], [55, 20, "up"], [45, 6, "up"], [38, 13, "down"],
    [32, 17, "down"], [27, 8, "up"], [36, 5, "up"], [48, 21, "down"],
    [56, 9, "down"], [63, 15, "up"], [51, 4, "up"], [42, 18, "down"],
    [37, 7, "down"], [31, 12, "up"], [40, 22, "up"], [49, 6, "down"],
    [57, 14, "down"], [61, 3, "up"], [53, 19, "up"], [44, 10, "down"],
  ] as const;

  const step = 100 / candles.length;

  return (
    <div className="chart-route-skeleton" aria-hidden>
      <div className="chart-route-skeleton-grid" />
      <div className="chart-route-skeleton-bars">
        {candles.map(([top, height, tone], index) => (
          <span
            key={index}
            className={`is-${tone}`}
            style={{
              left: `${index * step + step * 0.18}%`,
              width: `${step * 0.62}%`,
              top: `${top}%`,
              height: `${height}%`,
            }}
          >
            <i />
          </span>
        ))}
      </div>
      <div className="chart-route-skeleton-axis" />
    </div>
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
    <div className="markets-table" aria-busy aria-label="Loading markets">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="markets-row" aria-hidden>
          <span className="markets-pair">
            <span className="space-y-1.5">
              <Line className="h-4 w-20" />
              <Line className="h-3 w-28" />
            </span>
          </span>
          <Line className="h-4 w-16" />
          <Line className="h-4 w-12" />
          <span className="markets-row-plan">
            <Bone className="markets-row-analyze h-9 w-[5.25rem] rounded-full" />
          </span>
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
      className="signals-view signals-minimal signals-loading-skeleton grid w-full gap-5"
      aria-busy
      aria-label="Loading signals"
    >
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full">
          <div className="signals-chart-mobile lg:hidden">
            <div className="signals-mobile-content">
              <div className="signals-mobile-actions flex items-center justify-between">
                <Bone className="h-[2.35rem] w-[7.1rem] rounded-full" />
                <div className="flex items-center gap-2">
                  <Bone className="h-8 w-[5.6rem] rounded-lg" />
                  <Bone className="size-8 rounded-full" />
                </div>
              </div>
              <div className="gx-mobile-quote-row">
                <Line className="h-8 w-28" />
                <span className="gx-mobile-quote-meta">
                  <Line className="h-4 w-20" />
                  <Line className="h-3 w-9" />
                </span>
              </div>
              <div className="gx-mobile-timeframes">
                <div className="workspace-segment" aria-hidden>
                  {Array.from({ length: 5 }, (_, index) => (
                    <Bone key={index} className="workspace-segment-btn h-full w-full" />
                  ))}
                </div>
              </div>
            </div>
            <div className="relative min-h-[14rem] flex-1 overflow-hidden chart-data-shell chart-loading-static">
              <ChartScreenSkeleton />
            </div>
            <div className="gx-mobile-chart-toolbar px-3 py-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Bone key={index} className="h-[2.4rem] w-full rounded-[11px]" />
              ))}
            </div>
            <div className="gx-mobile-analyze-section">
              <Bone className="h-11 w-full rounded-xl" />
            </div>
          </div>

          <div className="signals-chart-desktop hidden lg:grid gx-chart-terminal">
            <div className="signals-chart-head">
              <div className="signals-chart-head-main">
                <Bone className="h-7 w-[6.75rem] rounded-md" />
                <div className="signals-chart-quote flex items-baseline gap-2">
                  <Line className="h-5 w-[4.75rem]" />
                  <Line className="h-3 w-16" />
                </div>
              </div>
              <div className="flex items-center gap-1" aria-hidden>
                {Array.from({ length: 5 }, (_, index) => (
                  <Bone key={index} className="h-7 w-10 rounded-md" />
                ))}
              </div>
              <div className="signals-chart-head-tools">
                <Bone className="h-7 w-[5.75rem] rounded-md" />
                <Bone className="h-7 w-[4.75rem] rounded-md" />
                <Bone className="h-7 w-12 rounded-md" />
                <Bone className="h-7 w-[4.25rem] rounded-md" />
                <Bone className="h-7 w-12 rounded-md" />
                <Bone className="size-7 rounded-md" />
                <Bone className="size-7 rounded-md" />
              </div>
            </div>

            <div className="gx-chart-stage">
              <div className="signals-chart-canvas chart-loading-static min-h-0 flex-1">
                <ChartScreenSkeleton />
              </div>
            </div>

            <div className="gx-active-position" aria-hidden>
              <Line className="h-3 w-20" />
              <Line className="h-3 w-14" />
              <Bone className="h-5 w-12 rounded" />
              {Array.from({ length: 6 }, (_, index) => (
                <span key={index} className="inline-flex items-baseline gap-1.5">
                  <Line className="h-2.5 w-8" />
                  <Line className="h-3.5 w-12" />
                </span>
              ))}
            </div>

            <aside className="gx-chart-context" aria-hidden>
              <div className="pending-entry-dialog is-panel">
                <header>
                  <Line className="h-2.5 w-16" />
                  <Line className="mt-2 h-5 w-28" />
                </header>
                <div className="pending-entry-form space-y-4 p-4">
                  <div className="grid grid-cols-2 gap-2">
                    <Bone className="h-10 w-full rounded-md" />
                    <Bone className="h-10 w-full rounded-md" />
                  </div>
                  {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} className="space-y-2">
                      <Line className="h-2.5 w-12" />
                      <Bone className="h-9 w-full rounded-md" />
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: 4 }, (_, index) => (
                      <Bone key={index} className="h-8 w-14 rounded-md" />
                    ))}
                  </div>
                  <Bone className="mt-2 h-10 w-full rounded-md" />
                </div>
              </div>
            </aside>
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
    <div className="markets-workspace" aria-busy aria-label="Loading markets">
      <header className="markets-header">
        <div>
          <Line className="h-7 w-28 lg:h-9 lg:w-36" />
        </div>
      </header>
      <div className="markets-terminal">
        <section className="markets-scanner">
          <div className="markets-toolbar">
            <Bone className="h-[2.05rem] w-full max-w-[18rem] rounded" />
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
