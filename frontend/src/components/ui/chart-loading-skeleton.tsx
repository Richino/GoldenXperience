import { SkeletonBlock as Block } from "@/components/ui/ledger-loading-skeletons";
import { ChartPlotSkeleton } from "@/components/ui/chart-plot-skeleton";

function PairPlaceholder({ compact = false }: { compact?: boolean }) {
  const size = compact ? 28 : 36;
  return (
    <div className="nl-pair">
      <span className="nl-skeleton-flags">
        <Block width={size} height={size} radius={999} />
        <Block width={size} height={size} radius={999} />
      </span>
      <Block width={compact ? 94 : 112} height={compact ? 20 : 23} />
      {!compact && <Block width={192} height={40} radius={12} />}
    </div>
  );
}

/**
 * The chart page while it loads, laid out like the live page so nothing jumps
 * when it arrives. Phone: pair, + and bell; the quote line; the timeframe
 * control and three tool icons; the chart down to the tab bar with the trade
 * pill in its corner (no bar under it). Desktop: the chart card with its own
 * toolbar, legend and status line; the side cards with a title bar each.
 */
export function ChartLoadingSkeleton() {
  return (
    <div className="signals-view signals-minimal signals-loading-skeleton grid w-full gap-5" aria-busy="true" aria-label="Loading chart">
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full" aria-hidden="true">
          <div className="signals-chart-mobile lg:hidden">
            <div className="signals-mobile-content">
              <div className="signals-mobile-actions nl-mhead">
                <PairPlaceholder compact />
                <div className="nl-mhead-actions">
                  <Block width={48} height={48} radius={16} />
                  <Block width={48} height={48} radius={16} />
                </div>
              </div>
              <div className="gx-mobile-quote-row nl-mquote nl-mquote-line">
                <div className="nl-mquote-main">
                  <span className="nl-mquote-price"><Block width={92} height={28} /></span>
                  <span className="nl-mquote-meta"><Block width={42} height={11} /></span>
                </div>
                <span className="nl-mquote-trend"><Block width={148} height={11} /></span>
                <span className="nl-mquote-spread"><Block width={28} height={11} /></span>
              </div>
              <div className="gx-mobile-chart-controls">
                <div className="gx-mobile-timeframes">
                  <div className="workspace-segment">
                    {Array.from({ length: 5 }, (_, i) => <span key={i} className="workspace-segment-btn nl-skeleton-control"><Block width={20} height={10} /></span>)}
                  </div>
                </div>
                <div className="gx-mobile-chart-toolbar gx-mobile-chart-quick">
                  {Array.from({ length: 3 }, (_, i) => <span key={i} className="gx-mobile-tool-button"><Block width={17} height={17} radius={5} /></span>)}
                </div>
              </div>
            </div>
            <div className="relative overflow-hidden chart-data-shell">
              <ChartPlotSkeleton />
              <Block className="nl-skeleton-trade-pill" width={132} height={36} radius={999} />
            </div>
          </div>

          <div className="hidden lg:flex signals-chart-desktop gx-chart-terminal nl-terminal">
            <header className="nl-chart-head">
              <div className="nl-chart-head-main">
                <PairPlaceholder />
                <div className="nl-chart-quote"><Block width={114} height={28} /><Block width={32} height={26} radius={999} /><Block width={132} height={26} radius={999} /><Block width={96} height={26} radius={999} /></div>
              </div>
              <Block width={48} height={48} radius={14} />
            </header>
            <div className="nl-chart-body">
              <div className="nl-chart-main">
                <div className="gx-chart-stage nl-chart-card">
                  <div className="nl-chart-toolbar">
                    <div className="workspace-tabs">{Array.from({ length: 5 }, (_, i) => <span key={i} className="workspace-tab-btn nl-skeleton-control"><Block width={18} height={9} /></span>)}</div>
                    <span className="gx-toolbar-btn nl-skeleton-control"><Block width={48} height={13} /></span>
                    <span className="gx-toolbar-icon-btn nl-skeleton-control"><Block width={16} height={16} /></span>
                    <span className="nl-toolbar-rule" />
                    <span className="gx-toolbar-icon-btn nl-skeleton-control"><Block width={16} height={16} /></span>
                    <div className="nl-toolbar-end">{Array.from({ length: 3 }, (_, i) => <span key={i} className="gx-toolbar-icon-btn nl-skeleton-control"><Block width={16} height={16} /></span>)}</div>
                  </div>
                  <div className="signals-chart-canvas chart-data-shell">
                    <ChartPlotSkeleton />
                  </div>
                  <div className="nl-chart-status">
                    <Block width={90} height={16} />
                    <Block width={84} height={11} />
                    <span className="nl-chart-status-end"><Block width={76} height={11} /></span>
                  </div>
                </div>
              </div>
              <aside className="nl-chart-side">
                <section className="nl-cside-card">
                  <div className="nl-cside-head"><Block width={96} height={20} /><Block width={56} height={12} /></div>
                  <div className="nl-cside-body">
                    <div className="nl-cside-empty-state"><Block width={34} height={34} radius={10} /><div><Block width={96} height={13} /><Block width={190} height={11} /></div></div>
                    <Block height={40} radius={12} />
                  </div>
                </section>
                <section className="nl-cside-card nl-cnews">
                  <div className="nl-cside-head"><Block width={118} height={20} /><Block width={84} height={12} /></div>
                  <div className="nl-skeleton-news">
                    {Array.from({ length: 3 }, (_, i) => (
                      <div key={i}><Block width={40} height={26} /><div><Block width="80%" height={13} /><Block width={70} height={11} /></div><Block width={34} height={18} radius={6} /></div>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
