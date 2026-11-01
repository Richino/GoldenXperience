import { SkeletonBlock as Block } from "@/components/ui/ledger-loading-skeletons";

/** Same quiet plot shimmer used while the live chart fetches candles. */
function Plot() {
  return <div className="chart-route-skeleton" aria-hidden="true"><div className="chart-loading-skeleton" /></div>;
}

/** A side-column card: uppercase head, then ruled rows. */
function SideCard({ title, rows, className = "" }: { title: number; rows: number; className?: string }) {
  return (
    <section className={`nl-cside-card ${className}`}>
      <div className="nl-cside-head"><Block width={title} height={10} /><Block width={56} height={10} /></div>
      <div className="nl-skel-rows">
        {Array.from({ length: rows }, (_, i) => (
          <div className="nl-skel-row" key={i}><Block width={i % 2 ? 132 : 150} height={11} /><Block width={52} height={11} /></div>
        ))}
      </div>
    </section>
  );
}

export function ChartLoadingSkeleton() {
  return (
    <div className="signals-view signals-minimal signals-loading-skeleton grid w-full gap-5" aria-busy="true" aria-label="Loading chart">
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full" aria-hidden="true">
          <div className="signals-chart-mobile lg:hidden">
            <div className="signals-mobile-content">
              <div className="signals-mobile-header nl-mhead">
                <div className="gx-mobile-quote-row nl-mquote"><div className="nl-mquote-main"><Block width={96} height={18} /><Block width={150} height={14} /></div></div>
                <div className="nl-mhead-actions">
                  {Array.from({ length: 3 }, (_, i) => <Block key={i} width={44} height={44} radius={4} />)}
                </div>
              </div>
              <div className="gx-mobile-timeframes nl-mtimeframes"><div className="nl-skeleton-timeframes is-six">{Array.from({ length: 6 }, (_, i) => <Block key={i} width="100%" height={30} />)}</div></div>
              <div className="nl-skel-ohlc"><Block width={220} height={11} /></div>
            </div>
            <div className="relative min-h-[14rem] flex-1 overflow-hidden chart-data-shell chart-loading-static"><Plot /></div>
            <div className="gx-mobile-analyze-section"><Block height={44} radius={4} /></div>
          </div>
          <div className="hidden lg:flex signals-chart-desktop gx-chart-terminal nl-terminal">
            <header className="nl-chart-head">
              <div className="nl-chart-head-main">
                <Block width={112} height={32} radius={4} />
                <div className="nl-chart-quote"><Block width={96} height={22} /><Block width={110} height={11} /></div>
                <div className="nl-skel-facts">
                  {[64, 64, 40, 104, 64].map((w, i) => <div key={i}><Block width={36} height={9} /><Block width={w} height={11} /></div>)}
                </div>
              </div>
              <div className="nl-chart-head-actions"><Block width={170} height={30} radius={4} /><Block width={32} height={32} radius={4} /><Block width={112} height={32} radius={4} /></div>
            </header>
            <div className="nl-chart-body">
              <div className="nl-chart-main">
                <div className="nl-chart-toolbar">
                  <div className="nl-skel-seg">{Array.from({ length: 7 }, (_, i) => <Block key={i} width={26} height={24} />)}</div>
                  <span className="nl-toolbar-rule" />
                  <Block width={36} height={30} /><Block width={36} height={30} /><Block width={78} height={30} /><Block width={102} height={30} />
                  <span className="nl-toolbar-rule" />
                  <div className="nl-skel-seg">{Array.from({ length: 7 }, (_, i) => <Block key={i} width={28} height={24} />)}</div>
                  <div className="nl-toolbar-end"><Block width={30} height={30} /><Block width={30} height={30} /></div>
                </div>
                <div className="gx-chart-stage nl-chart-card"><div className="signals-chart-canvas chart-loading-static min-h-0 flex-1"><Plot /></div></div>
              </div>
              <aside className="nl-chart-side">
                <SideCard title={52} rows={1} className="nl-book" />
                <SideCard title={104} rows={5} className="nl-cnews" />
                <SideCard title={72} rows={8} className="nl-cwl" />
              </aside>
            </div>
            <footer className="nl-cstatus"><Block width={220} height={10} /><Block width={140} height={10} /></footer>
          </div>
        </section>
      </div>
    </div>
  );
}
