import { SkeletonBlock as Block } from "@/components/ui/ledger-loading-skeletons";

/** Same quiet plot shimmer used while the live chart fetches candles. */
function Plot() {
  return <div className="chart-route-skeleton" aria-hidden="true"><div className="chart-loading-skeleton" /></div>;
}

export function ChartLoadingSkeleton() {
  return (
    <div className="signals-view signals-minimal signals-loading-skeleton grid w-full gap-5" aria-busy="true" aria-label="Loading chart">
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full" aria-hidden="true">
          <div className="signals-chart-mobile lg:hidden">
            <div className="signals-mobile-content">
              <div className="signals-mobile-actions nl-mhead">
                <Block className="nl-skeleton-pair" width={190} height={52} radius={15} />
                <div className="nl-mhead-actions">
                  <Block className="nl-skeleton-analyze" width={80} height={48} radius={16} />
                  <Block width={48} height={48} radius={16} />
                </div>
              </div>
              <div className="gx-mobile-quote-row nl-mquote">
                <div className="nl-mquote-main">
                  <span className="nl-mquote-price"><Block width="4em" height="1em" /></span>
                  <span className="nl-mquote-meta"><Block width={100} height={14} /></span>
                </div>
                <span className="nl-mquote-spread"><Block width={64} height={14} /></span>
                <div className="nl-mquote-sub"><Block width={200} height={14} /></div>
              </div>
              <div className="gx-mobile-chart-controls">
                <div className="gx-mobile-timeframes"><div className="nl-skeleton-timeframes">{Array.from({ length: 5 }, (_, i) => <Block key={i} width="100%" height={30} radius={9} />)}</div></div>
                <div className="gx-mobile-chart-toolbar gx-mobile-chart-quick">{Array.from({ length: 3 }, (_, i) => <Block key={i} width={36} height={36} radius={10} />)}</div>
              </div>
            </div>
            <div className="relative min-h-[14rem] flex-1 overflow-hidden chart-data-shell chart-loading-static"><Plot /></div>
            <div className="gx-mobile-analyze-section"><Block height={46} radius={14} /></div>
          </div>
          <div className="hidden lg:flex signals-chart-desktop gx-chart-terminal nl-terminal">
            <header className="nl-chart-head"><div className="nl-chart-head-main"><Block width={248} height={56} radius={18} /><div className="nl-chart-quote"><Block width={164} height={43} /><Block width={60} height={21} /><Block width={110} height={18} /><Block width={40} height={18} /></div></div><Block width={48} height={48} radius={14} /></header>
            <div className="nl-chart-body">
              <div className="nl-chart-main">
                <div className="nl-chart-toolbar"><div className="flex gap-1">{Array.from({ length: 5 }, (_, i) => <Block key={i} width={46} height={36} />)}</div><Block width={74} height={44} /><Block width={44} height={44} /><span className="nl-toolbar-rule" /><Block width={92} height={44} /><Block width={116} height={44} /><div className="nl-toolbar-end">{Array.from({ length: 3 }, (_, i) => <Block key={i} width={44} height={44} />)}</div></div>
                <div className="gx-chart-stage nl-chart-card"><div className="signals-chart-canvas chart-loading-static min-h-0 flex-1"><Plot /></div></div>
              </div>
              <aside className="nl-chart-side">
                <section className="nl-an-card"><div className="nl-an-body"><div className="nl-an-top"><Block width={150} height={20} /></div><h2 className="nl-an-decision"><Block width="5em" height="1em" /></h2><div className="nl-an-actions is-card"><Block height={48} /><Block height={48} /></div></div></section>
                <section className="nl-cside-card"><div className="nl-cside-head"><Block width={130} height={24} /></div><div className="nl-cside-empty"><Block width={220} height={20} /></div></section>
              </aside>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
