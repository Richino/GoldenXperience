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

function CardShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`app-card overflow-hidden ${className}`}>{children}</div>
  );
}

function SectionHeaderSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      <Line className="h-3 w-24" />
      {lines > 1 ? <Line className="h-4 w-40" /> : null}
    </div>
  );
}

function StatGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className={`grid gap-6 ${count === 3 ? "sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-2">
          <Line className="h-3 w-16" />
          <Line className="h-7 w-20" />
          <Line className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

function ListRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-[color:var(--border)] border-t border-[color:var(--border)]">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-3 px-5 py-3.5 md:px-6"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Line className="h-4 w-28" />
            <Line className="h-3 w-36" />
          </div>
          <Line className="h-4 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function PageIntroSkeleton({
  titleWidth = "w-48",
  subtitleWidth = "w-72",
}: {
  titleWidth?: string;
  subtitleWidth?: string;
}) {
  return (
    <header>
      <Line className={`h-8 ${titleWidth}`} />
      <Line className={`mt-2 h-4 ${subtitleWidth}`} />
    </header>
  );
}

function PanelCardSkeleton({ statCols = 2 }: { statCols?: number }) {
  return (
    <CardShell className="p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <SectionHeaderSkeleton />
        <Bone className="h-7 w-24 shrink-0 rounded-full" />
      </div>
      <div
        className={`mt-4 grid gap-4 border-t border-[color:var(--border)] pt-4 ${
          statCols === 3 ? "grid-cols-3" : "grid-cols-2"
        }`}
      >
        {Array.from({ length: statCols * 2 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Line className="h-3 w-20" />
            <Line className="h-4 w-24" />
          </div>
        ))}
      </div>
    </CardShell>
  );
}

export function DashboardLoadingSkeleton() {
  return (
    <div className="dashboard-view dashboard-minimal space-y-8 animate-pulse lg:space-y-10" aria-busy aria-label="Loading dashboard">
      <div>
        <div className="flex items-center justify-between gap-3 lg:hidden">
          <div className="flex items-center gap-3">
            <Bone className="size-9 shrink-0 rounded-full" />
            <Line className="h-5 w-28" />
          </div>
          <Bone className="size-9 shrink-0 rounded-full" />
        </div>
        <Line className="mt-7 h-4 w-24 lg:mt-0" />
        <Line className="mt-3 h-10 w-52 lg:h-12 lg:w-64" />
        <Bone className="mt-3 h-6 w-24 rounded-full" />
        <div className="mt-8 flex items-center justify-between lg:mt-10">
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Bone key={index} className="h-7 w-10 rounded-full" />
            ))}
          </div>
          <div className="flex gap-2">
            <Bone className="size-8 rounded-lg" />
            <Bone className="size-8 rounded-lg" />
          </div>
        </div>
        <Bone className="mt-4 h-60 w-full rounded-2xl lg:h-72" />
      </div>

      <div className="dashboard-minimal-grid">
        <div className="space-y-3 border-t border-[color:var(--border)] pt-5 lg:border-t-0 lg:pt-0">
          <div className="flex justify-between">
            <Line className="h-4 w-28" />
            <Line className="h-4 w-12" />
          </div>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center justify-between py-2">
              <div className="space-y-2">
                <Line className="h-4 w-28" />
                <Line className="h-3 w-20" />
              </div>
              <Line className="h-4 w-16" />
            </div>
          ))}
        </div>
        <div className="space-y-2 border-t border-[color:var(--border)] pt-5 lg:border-t-0 lg:pt-0">
          {Array.from({ length: 3 }, (_, index) => (
            <Bone key={index} className="h-11 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SignalsLoadingSkeleton() {
  return (
    <div
      className="signals-view signals-minimal grid w-full animate-pulse gap-5 xl:grid-cols-[minmax(0,1fr)_272px]"
      aria-busy
      aria-label="Loading signals"
    >
      <CardShell className="signals-chart-card">
        <div className="hidden lg:block">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[color:var(--border)] px-5 py-4">
            <div className="flex items-center gap-3">
              <Bone className="size-10 shrink-0 rounded-full" />
              <div className="space-y-2">
                <Line className="h-4 w-20" />
                <Line className="h-3 w-16" />
              </div>
              <div className="ml-4 space-y-2">
                <Line className="h-5 w-24" />
                <Line className="h-3 w-16" />
              </div>
            </div>
            <div className="flex gap-2">
              <Bone className="h-9 w-9 rounded-full" />
              <Bone className="h-9 w-9 rounded-full" />
              <Bone className="h-9 w-9 rounded-full" />
            </div>
          </div>
          <div className="flex gap-2 border-b border-[color:var(--border)] px-5 py-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Bone key={index} className="h-8 w-12 rounded-full" />
            ))}
          </div>
          <Bone className="mx-5 mt-4 mb-5 h-[420px] rounded-[20px]" />
        </div>

        <div className="lg:hidden">
          <div className="px-4 pb-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="flex items-center justify-between">
              <Bone className="size-9 rounded-full" />
              <Bone className="size-9 rounded-full" />
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Bone className="size-9 rounded-full" />
                <div className="space-y-2">
                  <Line className="h-4 w-20" />
                  <Line className="h-3 w-16" />
                </div>
              </div>
              <Line className="h-5 w-24" />
            </div>
            <Bone className="mt-3 h-10 w-full rounded-full" />
            <div className="mt-3 flex gap-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Bone key={index} className="h-8 w-12 rounded-full" />
              ))}
            </div>
          </div>
          <Bone className="h-[60vh] w-full rounded-none" />
          <div className="border-t border-[color:var(--border)] px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex gap-2">
                {Array.from({ length: 5 }, (_, index) => (
                  <Bone key={index} className="h-8 w-10 rounded-full" />
                ))}
              </div>
              <Bone className="h-8 w-8 rounded-full" />
            </div>
            <div className="mt-2 flex gap-4">
              <Line className="h-4 w-16" />
              <Line className="h-4 w-12" />
            </div>
          </div>
          <div className="space-y-3 px-4 py-5">
            <Line className="h-3 w-40" />
            <Bone className="h-1 w-full rounded-full" />
            <Line className="h-3 w-28" />
          </div>
        </div>
      </CardShell>

      <aside className="dashboard-minimal-section hidden space-y-4 xl:block">
        <div className="flex items-baseline justify-between gap-3">
          <Line className="h-4 w-16" />
          <Line className="h-3 w-12" />
        </div>
        <Line className="h-4 w-28" />
        <Line className="h-3 w-24" />
        <Bone className="h-1 w-full rounded-full" />
        <div className="space-y-2 border-t border-[color:var(--border)] pt-4">
          <Line className="h-4 w-20" />
          <Line className="h-3 w-full" />
          <Line className="h-3 w-40" />
        </div>
      </aside>
    </div>
  );
}

export function JournalLoadingSkeleton() {
  return (
    <div className="journal-view journal-minimal space-y-8 animate-pulse lg:space-y-10" aria-busy aria-label="Loading journal">
      <div className="space-y-2">
        <Line className="h-8 w-28" />
        <Line className="h-4 w-32" />
      </div>

      <section className="journal-stats-card grid grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="journal-stat min-w-0 space-y-2">
            <Line className="h-3 w-12" />
            <Line className="h-6 w-14" />
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1.5">
            <Line className="h-4 w-24" />
            <Line className="h-3 w-28" />
          </div>
          <Bone className="size-8 shrink-0 rounded-full" />
        </div>
      </section>

      <section className="dashboard-minimal-section">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Line className="h-4 w-20" />
          <div className="flex gap-1.5">
            {Array.from({ length: 4 }, (_, index) => (
              <Bone key={index} className="h-7 w-14 rounded-full" />
            ))}
          </div>
        </div>
        <div className="mt-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="dashboard-minimal-row flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Line className="h-5 w-12 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Line className="h-4 w-36" />
                  <Line className="h-3 w-48" />
                </div>
              </div>
              <Line className="h-3 w-10 shrink-0" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function WatchlistLoadingSkeleton() {
  return (
    <div className="watchlist-view watchlist-minimal space-y-8 animate-pulse lg:space-y-10" aria-busy aria-label="Loading watchlist">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Line className="h-8 w-36" />
          <Line className="h-4 w-40" />
        </div>
        <Bone className="size-9 shrink-0 rounded-full" />
      </div>

      <section className="dashboard-minimal-section">
        <div className="flex items-center justify-between gap-3">
          <Line className="h-4 w-16" />
          <Line className="h-3 w-8" />
        </div>
        <div className="mt-3">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="dashboard-minimal-row flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Line className="h-4 w-28" />
                <Line className="h-3 w-36" />
                <Line className="h-3 w-48" />
              </div>
              <div className="shrink-0 space-y-2 text-right">
                <Line className="ml-auto h-4 w-24" />
                <Line className="ml-auto h-3 w-20" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function RiskLoadingSkeleton() {
  return (
    <div className="risk-view risk-minimal space-y-8 animate-pulse lg:space-y-10" aria-busy aria-label="Loading risk">
      <div className="space-y-2">
        <Line className="h-8 w-24" />
        <Line className="h-4 w-28" />
      </div>

      <section className="risk-stats-card">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Line className="h-3 w-12" />
            <Line className="h-6 w-16" />
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section space-y-4">
        <div className="flex items-center justify-between">
          <Line className="h-4 w-20" />
          <Line className="h-3 w-16" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Line className="h-3 w-20" />
              <Bone className="h-11 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </section>

      <div className="dashboard-minimal-grid space-y-8 lg:space-y-0">
        <section className="dashboard-minimal-section">
          <Line className="h-4 w-28" />
          <div className="mt-3 space-y-0">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="dashboard-minimal-row flex items-center justify-between gap-3 py-3">
                <div className="space-y-2">
                  <Line className="h-4 w-28" />
                  <Line className="h-3 w-16" />
                </div>
                <Line className="h-4 w-12" />
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
    </div>
  );
}

export function SettingsLoadingSkeleton() {
  return (
    <div className="settings-view settings-minimal space-y-8 animate-pulse lg:space-y-10" aria-busy aria-label="Loading settings">
      <div>
        <Line className="h-9 w-36 lg:h-10 lg:w-40" />
        <Line className="mt-2 h-4 w-56" />
      </div>

      {Array.from({ length: 4 }, (_, section) => (
        <div key={section} className="settings-minimal-section space-y-4">
          <Line className="h-4 w-24" />
          {Array.from({ length: section === 0 ? 2 : 3 }, (_, index) => (
            <div key={index} className="flex items-center justify-between gap-3 py-1">
              <div className="space-y-2">
                <Line className="h-4 w-28" />
                <Line className="h-3 w-36" />
              </div>
              <Bone className="h-9 w-28 rounded-xl" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ResearchLoadingSkeleton() {
  return (
    <div className="research-view research-minimal space-y-8 animate-pulse lg:space-y-10" aria-busy aria-label="Loading research">
      <div className="space-y-2">
        <Line className="h-8 w-36" />
        <Line className="h-4 w-44" />
      </div>

      <section className="research-minimal-section space-y-4">
        <div className="flex items-center justify-between">
          <Line className="h-4 w-24" />
          <Line className="h-3 w-20" />
        </div>
        <div className="flex justify-between">
          <div className="space-y-2">
            <Line className="h-4 w-20" />
            <Line className="h-3 w-40" />
          </div>
          <Line className="h-8 w-16" />
        </div>
        <Bone className="h-1.5 w-full rounded-full" />
        <StatGridSkeleton count={4} />
      </section>

      <section className="research-minimal-section space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Line className="h-4 w-28" />
          <div className="flex gap-2">
            <Bone className="h-9 w-24 rounded-xl" />
            <Bone className="h-9 w-36 rounded-xl" />
            <Bone className="h-9 w-32 rounded-xl" />
          </div>
        </div>
      </section>

      <section className="research-minimal-section space-y-3">
        <Line className="h-4 w-40" />
        <StatGridSkeleton count={4} />
        <Line className="h-3 w-full" />
      </section>

      {Array.from({ length: 2 }, (_, section) => (
        <section key={section} className="research-minimal-section space-y-4">
          <Line className="h-4 w-36" />
          <ListRowsSkeleton rows={3} />
        </section>
      ))}
    </div>
  );
}
