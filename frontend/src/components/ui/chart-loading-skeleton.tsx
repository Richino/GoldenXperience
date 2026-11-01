import { SkeletonBlock as Block } from "@/components/ui/ledger-loading-skeletons";

/** Same quiet plot shimmer used while the live chart fetches candles. */
function Plot() {
  return <div className="chart-route-skeleton" aria-hidden="true"><div className="chart-loading-skeleton" /></div>;
}

/* Side-column cards, built from the loaded cards' own classes so rows and
   padding line up: Trades (empty note), Upcoming news, Watchlist. */
function SideBook() {
  return (
    <section className="nl-cside-card nl-book">
      <div className="nl-cside-head"><Block width={52} height={10} /></div>
      <div className="nl-book-empty">
        <span className="flex h-5 items-center"><Block width={150} height={12} /></span>
        <span className="flex h-[17px] items-center"><Block width={230} height={10} /></span>
        <span className="flex h-[17px] items-center"><Block width={120} height={10} /></span>
      </div>
    </section>
  );
}

function SideNews() {
  return (
    <section className="nl-cside-card nl-cnews">
      <div className="nl-cside-head"><Block width={104} height={10} /><Block width={56} height={10} /></div>
      <div className="nl-news-list">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="nl-news-row" key={i}>
            <span className="nl-news-when flex h-[34px] flex-col justify-center gap-1.5"><Block width={24} height={8} /><Block width={36} height={11} /></span>
            <span className="nl-news-copy flex flex-col gap-1.5"><Block width={i % 2 ? 130 : 160} height={11} /><Block width={56} height={9} /></span>
            <Block width={24} height={12} />
          </div>
        ))}
      </div>
    </section>
  );
}

function SideWatchlist() {
  return (
    <section className="nl-cside-card nl-cwl">
      <div className="nl-cside-head"><Block width={72} height={10} /><Block width={56} height={10} /></div>
      <div className="nl-cwl-list">
        {Array.from({ length: 12 }, (_, i) => (
          <div className="nl-cwl-row" key={i}>
            <span><Block width={56} height={11} /></span>
            <span><Block width={52} height={11} /></span>
            <span><Block width={40} height={11} /></span>
          </div>
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
              {/* Same header parts as the loaded page: pair line, then price · change · spread. */}
              <div className="signals-mobile-actions nl-mhead">
                <div className="nl-mhead-quote">
                  <div className="flex h-[26px] items-center"><Block width={84} height={18} /></div>
                  <div className="flex h-[19px] items-center"><Block width={150} height={14} /></div>
                </div>
                <div className="signals-mobile-header-actions nl-mhead-actions">
                  {Array.from({ length: 3 }, (_, i) => <Block key={i} width={44} height={44} radius={4} />)}
                </div>
              </div>
              <div className="gx-mobile-timeframes nl-mtimeframes"><div className="nl-skeleton-timeframes is-six">{Array.from({ length: 6 }, (_, i) => <span key={i} className="nl-skel-tf"><Block width={18} height={10} /></span>)}</div></div>
              {/* Candle values and the trend read; the trend wraps under the values on a narrow phone, as loaded. */}
              <div className="nl-mohlc">
                <div className="nl-mohlc-values h-4 items-center"><Block width={232} height={11} /></div>
                <span className="nl-mohlc-trend flex h-4 items-center"><Block width={124} height={11} /></span>
              </div>
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
                <SideBook />
                <SideNews />
                <SideWatchlist />
              </aside>
            </div>
            <footer className="nl-cstatus"><Block width={220} height={10} /><Block width={140} height={10} /></footer>
          </div>
        </section>
      </div>
    </div>
  );
}
