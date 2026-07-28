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
    <div className="dashboard-view space-y-5 animate-pulse" aria-busy aria-label="Loading dashboard">
      <CardShell className="app-card-hero p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 space-y-3">
            <Line className="h-3 w-52" />
            <Line className="h-8 w-64" />
            <Line className="h-4 w-80 max-w-full" />
          </div>
          <Bone className="h-8 w-36 shrink-0 rounded-full" />
        </div>
      </CardShell>

      <div className="grid gap-5 lg:grid-cols-2">
        <PanelCardSkeleton statCols={2} />
        <PanelCardSkeleton statCols={3} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <PanelCardSkeleton statCols={2} />
        <PanelCardSkeleton statCols={2} />
      </div>

      <CardShell className="p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <SectionHeaderSkeleton />
          <Bone className="h-7 w-28 shrink-0 rounded-full" />
        </div>
        <Line className="mt-4 h-8 w-24" />
        <Bone className="mt-3 h-2 w-full rounded-full" />
        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[color:var(--border)] pt-4 sm:grid-cols-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Line className="h-3 w-20" />
              <Line className="h-4 w-24" />
            </div>
          ))}
        </div>
      </CardShell>

      <CardShell>
        <div className="flex items-center justify-between gap-3 px-5 py-5 md:px-6">
          <SectionHeaderSkeleton />
          <Line className="h-4 w-24" />
        </div>
        <ListRowsSkeleton rows={4} />
      </CardShell>
    </div>
  );
}

export function SignalsLoadingSkeleton() {
  return (
    <div
      className="signals-view grid w-full animate-pulse gap-5 xl:grid-cols-[minmax(0,1fr)_272px]"
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
                <Line className="h-3 w-28" />
              </div>
              <div className="ml-4 space-y-2">
                <Line className="h-5 w-24" />
                <Line className="h-3 w-20" />
              </div>
            </div>
            <div className="flex gap-2">
              <Bone className="h-9 w-44 rounded-full" />
              <Bone className="h-9 w-9 rounded-full" />
              <Bone className="h-9 w-9 rounded-full" />
            </div>
          </div>
          <div className="flex gap-2 border-b border-[color:var(--border)] px-5 py-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Bone key={index} className="h-8 w-12 rounded-full" />
            ))}
            <Bone className="ml-auto h-8 w-24 rounded-full" />
          </div>
          <Bone className="mx-5 mt-4 h-[420px] rounded-[20px]" />
          <div className="flex justify-between gap-3 px-5 py-4">
            <div className="flex gap-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Bone key={index} className="h-8 w-10 rounded-full" />
              ))}
            </div>
            <Bone className="h-8 w-20 rounded-full" />
          </div>
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
                  <Line className="h-3 w-24" />
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
          <Bone className="mx-4 h-[320px] rounded-[20px]" />
          <div className="mt-3 flex gap-4 px-4">
            <Line className="h-4 w-16" />
            <Line className="h-4 w-12" />
          </div>
          <div className="space-y-4 px-4 py-5">
            <StatGridSkeleton count={4} />
            <Bone className="h-16 w-full rounded-2xl" />
          </div>
        </div>
      </CardShell>

      <aside className="hidden space-y-4 xl:block">
        <CardShell className="p-4">
          <SectionHeaderSkeleton />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 4 }, (_, index) => (
              <Line key={index} className="h-3 w-full" />
            ))}
          </div>
        </CardShell>
        <CardShell className="p-4">
          <Line className="h-4 w-28" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex gap-2">
                <Bone className="size-4 shrink-0 rounded-full" />
                <Line className="h-3 flex-1" />
              </div>
            ))}
          </div>
        </CardShell>
      </aside>
    </div>
  );
}

export function JournalLoadingSkeleton() {
  return (
    <div className="journal-view space-y-6 animate-pulse" aria-busy aria-label="Loading journal">
      <PageIntroSkeleton titleWidth="w-32" subtitleWidth="w-80" />

      <CardShell className="px-5 py-5 md:px-6">
        <StatGridSkeleton count={3} />
      </CardShell>

      <CardShell>
        <div className="flex items-center justify-between gap-3 px-5 py-4 md:px-6">
          <SectionHeaderSkeleton />
          <Bone className="size-8 shrink-0 rounded-full" />
        </div>
      </CardShell>

      <CardShell>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 md:px-6">
          <Line className="h-4 w-24" />
          <div className="flex gap-1.5">
            {Array.from({ length: 4 }, (_, index) => (
              <Bone key={index} className="h-8 w-16 rounded-full" />
            ))}
          </div>
        </div>
        <div className="divide-y divide-[color:var(--border)] border-t border-[color:var(--border)]">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex gap-4 px-5 py-4 md:px-6">
              <Bone className="h-12 w-14 shrink-0 rounded-2xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Line className="h-4 w-40" />
                <Line className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      </CardShell>
    </div>
  );
}

export function RiskLoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy aria-label="Loading risk plan">
      <PageIntroSkeleton titleWidth="w-36" subtitleWidth="w-full max-w-lg" />

      <section className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <CardShell key={index} className="p-5">
            <div className="flex items-start justify-between">
              <Line className="h-3 w-24" />
              <Bone className="size-9 rounded-2xl" />
            </div>
            <Line className="mt-4 h-8 w-20" />
            <Line className="mt-2 h-3 w-28" />
          </CardShell>
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <CardShell>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--border)] px-4 py-4 md:px-5">
            <div className="flex items-center gap-3">
              <Bone className="size-10 rounded-2xl" />
              <SectionHeaderSkeleton />
            </div>
            <Bone className="h-7 w-28 rounded-full" />
          </div>
          <div className="grid gap-4 p-4 md:grid-cols-2 md:p-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Line className="h-3 w-24" />
                <Bone className="h-11 w-full rounded-xl" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-[color:var(--border)] p-4 md:grid-cols-4 md:p-5">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-2 rounded-2xl bg-[color:var(--surface-raised)] p-3">
                <Line className="h-3 w-12" />
                <Line className="h-4 w-16" />
              </div>
            ))}
          </div>
        </CardShell>

        <CardShell className="p-5">
          <div className="flex items-start gap-3">
            <Bone className="size-11 shrink-0 rounded-2xl" />
            <SectionHeaderSkeleton lines={3} />
          </div>
          <div className="mt-5 space-y-2">
            {Array.from({ length: 3 }, (_, index) => (
              <Bone key={index} className="h-12 w-full rounded-2xl" />
            ))}
          </div>
        </CardShell>
      </div>

      <CardShell>
        <div className="border-b border-[color:var(--border)] px-5 py-4">
          <SectionHeaderSkeleton />
        </div>
        <div className="divide-y divide-[color:var(--border)]">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex gap-4 px-5 py-4">
              <Line className="h-3 w-6 shrink-0" />
              <div className="flex-1 space-y-2">
                <Line className="h-4 w-40" />
                <Line className="h-3 w-full max-w-md" />
              </div>
            </div>
          ))}
        </div>
      </CardShell>
    </div>
  );
}

export function SettingsLoadingSkeleton() {
  return (
    <div className="settings-view space-y-6 animate-pulse" aria-busy aria-label="Loading settings">
      <PageIntroSkeleton titleWidth="w-36" subtitleWidth="w-56" />

      <CardShell className="p-5 md:p-6">
        <Line className="h-4 w-28" />
        <div className="mt-4 space-y-4">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-wrap items-center justify-between gap-3">
              <Line className="h-4 w-20" />
              <Bone className="h-9 w-40 rounded-full" />
            </div>
          ))}
        </div>
      </CardShell>

      <CardShell className="p-5 md:p-6">
        <Line className="h-4 w-20" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 2 }, (_, index) => (
            <Bone key={index} className="h-16 w-full rounded-2xl" />
          ))}
          <div className="mt-2 space-y-2 border-t border-[color:var(--border)] pt-2">
            {Array.from({ length: 2 }, (_, index) => (
              <Bone key={index} className="h-11 w-full rounded-xl" />
            ))}
          </div>
          <Bone className="mt-4 h-10 w-full rounded-full" />
        </div>
      </CardShell>

      <CardShell className="p-5 md:p-6">
        <Line className="h-4 w-16" />
        <div className="mt-4 grid gap-6 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Line className="h-3 w-20" />
              <Line className="h-4 w-28" />
              <Line className="h-3 w-24" />
            </div>
          ))}
        </div>
      </CardShell>
    </div>
  );
}
