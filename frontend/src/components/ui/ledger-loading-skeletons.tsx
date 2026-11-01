import type { CSSProperties } from "react";

/**
 * Quiet placeholders built from the same classes as the loaded pages, so each
 * skeleton lands where the real content will and follows the same breakpoints
 * and container queries. Trades uses `nl-tx-*`, Markets `nl-mx-*`, Settings
 * `nl-st-*`.
 */
export function SkeletonBlock({ width = "100%", height = 12, radius = 3, className = "" }: {
  width?: CSSProperties["width"]; height?: CSSProperties["height"]; radius?: number; className?: string;
}) {
  return <span aria-hidden="true" className={`gx-skel max-w-full ${className}`} style={{ width, height, borderRadius: radius }} />;
}

/* ---------------------------------------------------------------- trades */

export function TradesSummarySkeleton() {
  return (
    <section className="nl-tx-panel nl-tx-summary nl-skel-panel" aria-hidden="true">
      <div className="nl-tx-hero">
        <span className="nl-tx-lbl"><SkeletonBlock width={168} height={10} /></span>
        <span className="nl-tx-hero-value"><SkeletonBlock width="5.2em" height="0.8em" /></span>
        <span className="nl-tx-hero-sub"><SkeletonBlock width={180} height={11} /></span>
      </div>
      <div className="nl-tx-curve">
        <div className="nl-tx-curve-head"><SkeletonBlock width={200} height={10} /><SkeletonBlock width={64} height={11} /></div>
        <SkeletonBlock height={72} />
      </div>
      <dl className="nl-tx-stats">
        {Array.from({ length: 4 }, (_, i) => (
          <div className="nl-tx-tile" key={i}><dt><SkeletonBlock width={48} height={10} /></dt><dd><SkeletonBlock width={56} height={18} /></dd></div>
        ))}
      </dl>
      <div className="nl-tx-wl">
        <SkeletonBlock height={6} />
        <div className="nl-tx-wl-legend"><SkeletonBlock width={150} height={11} /><SkeletonBlock width={150} height={11} /></div>
      </div>
    </section>
  );
}

export function TradesToolbarSkeleton({ showFilters = false }: { showFilters?: boolean }) {
  return (
    <div className="nl-tx-toolbar nl-skeleton-toolbar" aria-hidden="true">
      <div className="nl-tx-seg nl-tx-tabs">{[72, 84, 60].map((w) => <SkeletonBlock key={w} width={w} height={26} />)}</div>
      <div className="nl-tx-toolbar-row">
        <span className="nl-tx-search"><SkeletonBlock width={14} height={14} /><SkeletonBlock width={90} height={11} /></span>
        {showFilters ? <div className="nl-tx-seg nl-tx-filters">{[32, 40, 50].map((w) => <SkeletonBlock key={w} width={w} height={26} />)}</div> : null}
      </div>
    </div>
  );
}

/** List rows (desktop table, phone cards) inside the panel the page already drew. */
export function TradesSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className="nl-tx-thead">
        {[40, 36, 36, 32, 40, 16, 28, 32, 48].map((w, i) => <SkeletonBlock key={i} className={i ? "is-end" : ""} width={w} height={9} />)}
      </div>
      <div className="nl-tx-trows">
        {Array.from({ length: rows }, (_, i) => (
          <div className="nl-tx-trow is-static" key={i}>
            <span className="nl-tx-pair-cell"><SkeletonBlock width={64} height={13} /><SkeletonBlock width={44} height={10} /></span>
            {[56, 56, 56, 56, 40, 64, 28, 96].map((w, cell) => <span className="is-end" key={cell}><SkeletonBlock width={w} height={11} /></span>)}
          </div>
        ))}
      </div>
      <div className="nl-tx-cards">
        {Array.from({ length: rows }, (_, i) => (
          <div className="nl-tx-card" key={i}>
            <span className="nl-tx-card-line"><SkeletonBlock width={110} height={14} /><SkeletonBlock width={72} height={14} /></span>
            <span className="nl-tx-card-line"><SkeletonBlock width={140} height={11} /><SkeletonBlock width={44} height={11} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LedgerTradesLoadingSkeleton() {
  return (
    <div className="nl-tx" aria-busy="true" aria-label="Loading trades">
      <header className="nl-tx-head" aria-hidden="true">
        <div className="nl-tx-title">
          <span className="nl-tx-over"><SkeletonBlock width={180} height={10} /></span>
          <h1><SkeletonBlock width="4.2em" height="0.8em" /></h1>
        </div>
        <div className="nl-tx-head-actions"><SkeletonBlock width={44} height={44} radius={4} /></div>
      </header>
      <div className="nl-tx-main">
        <TradesSummarySkeleton />
        <TradesToolbarSkeleton showFilters />
        <div className="nl-tx-body" aria-hidden="true">
          <div className="nl-tx-list">
            <section className="nl-tx-panel">
              <div className="nl-tx-ph"><div className="nl-tx-ph-title"><SkeletonBlock width={110} height={11} /><SkeletonBlock width={20} height={11} /></div></div>
              <TradesSkeleton />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- markets */

export function MarketRowSkeleton() {
  return (
    <div className="nl-mx-row nl-mx-row-loading" aria-hidden="true">
      <span className="nl-mx-pair">
        <span className="nl-mx-pair-name"><SkeletonBlock width={64} height={13} /></span>
        <span className="nl-mx-pair-status"><SkeletonBlock width={128} height={10} /></span>
      </span>
      <SkeletonBlock className="nl-mx-spark" height={20} />
      <span className="nl-mx-price"><SkeletonBlock width={62} height={12} /></span>
      <span className="nl-mx-change"><SkeletonBlock width={44} height={11} /></span>
      <span className="nl-mx-range"><SkeletonBlock height={4} /><span className="nl-mx-range-ends"><SkeletonBlock width={48} height={9} /><SkeletonBlock width={48} height={9} /></span></span>
      <span className="nl-mx-spread"><SkeletonBlock width={24} height={11} /></span>
    </div>
  );
}

/** The table inside the All pairs panel the page already drew. */
export function LedgerWatchlistPairsSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading markets">
      <div className="nl-mx-rowhead" aria-hidden="true">
        {[28, 36, 32, 40, 56, 40].map((w, i) => <span key={i} className={i === 2 || i === 3 || i === 5 ? "is-end" : undefined}><SkeletonBlock width={w} height={9} /></span>)}
      </div>
      <div className="nl-mx-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => <MarketRowSkeleton key={i} />)}
      </div>
    </div>
  );
}

export function LedgerMarketsLoadingSkeleton() {
  return (
    <div className="nl-mx" aria-busy="true" aria-label="Loading markets">
      <header className="nl-mx-head" aria-hidden="true">
        <div className="nl-mx-title">
          <span className="nl-mx-over"><SkeletonBlock width={112} height={10} /></span>
          <h1><SkeletonBlock width="4.6em" height="0.8em" /></h1>
        </div>
        <div className="nl-mx-head-actions"><SkeletonBlock width={44} height={44} radius={4} /></div>
      </header>
      <div className="nl-mx-main">
        <section className="nl-mx-panel nl-mx-all" aria-hidden="true">
          <div className="nl-mx-ph"><div className="nl-mx-ph-title"><SkeletonBlock width={72} height={11} /><SkeletonBlock width={20} height={11} /></div><SkeletonBlock width={150} height={10} /></div>
          <div className="nl-mx-toolbar nl-skeleton-toolbar">
            <div className="nl-mx-seg nl-mx-groups">{[44, 56, 64, 56].map((w, i) => <SkeletonBlock key={i} width={w} height={26} />)}</div>
            <div className="nl-mx-toolbar-row">
              <span className="nl-mx-search"><SkeletonBlock width={14} height={14} /><SkeletonBlock width={110} height={11} /></span>
              <div className="nl-mx-seg nl-mx-sorts">{[92, 86, 36].map((w, i) => <SkeletonBlock key={i} width={w} height={26} />)}</div>
            </div>
          </div>
          <LedgerWatchlistPairsSkeleton />
        </section>
        <aside className="nl-mx-aside" aria-hidden="true">
          <section className="nl-mx-panel nl-mx-sess">
            <div className="nl-mx-ph"><SkeletonBlock width={64} height={11} /><SkeletonBlock width={72} height={10} /></div>
            <div className="nl-skel-stack">
              <SkeletonBlock width={120} height={12} />
              {Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} height={8} />)}
              <SkeletonBlock height={9} />
            </div>
          </section>
          <section className="nl-mx-panel">
            <div className="nl-mx-ph"><SkeletonBlock width={150} height={11} /><SkeletonBlock width={72} height={10} /></div>
            <div className="nl-mx-movers">
              {Array.from({ length: 4 }, (_, i) => (
                <div className="nl-mx-mover" key={i}>
                  <span className="nl-mx-mover-top"><SkeletonBlock width={60} height={12} /><SkeletonBlock width={40} height={11} /></span>
                  <SkeletonBlock height={28} />
                  <SkeletonBlock width={64} height={12} />
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- settings */

function SettingsRows({ count = 2 }: { count?: number }) {
  return <>{Array.from({ length: count }, (_, i) => <div className="nl-st-mrow" key={i}><SkeletonBlock width={124} height={13} /><SkeletonBlock width={72} height={12} /></div>)}</>;
}

export function LedgerSettingsLoadingSkeleton() {
  return (
    <div className="nl-st" aria-busy="true" aria-label="Loading settings">
      <header className="nl-st-head" aria-hidden="true">
        <span className="nl-overline"><SkeletonBlock width={72} height={10} /></span>
        <h1><SkeletonBlock width="4.6em" height="0.8em" /></h1>
      </header>
      <div className="nl-st-layout" aria-hidden="true">
        <div className="nl-st-index nl-st-desk">{Array.from({ length: 3 }, (_, i) => <div className="nl-skeleton-index" key={i}><SkeletonBlock width={14} height={10} /><SkeletonBlock width={96} height={12} /></div>)}</div>
        <div className="nl-st-content">
          <section className="nl-st-card nl-st-desk">
            <div className="nl-st-card-head"><SkeletonBlock width={140} height={14} /><SkeletonBlock width={120} height={10} /></div>
            <div className="nl-st-risk-hero"><div className="nl-st-risk-main"><SkeletonBlock width={90} height={10} /><SkeletonBlock width={160} height={36} /><SkeletonBlock width={220} height={11} /></div><div className="nl-st-presets">{Array.from({ length: 4 }, (_, i) => <SkeletonBlock key={i} width={72} height={36} />)}</div></div>
            <div className="nl-st-block"><SkeletonBlock width={120} height={10} /><div className="nl-st-positions">{Array.from({ length: 10 }, (_, i) => <SkeletonBlock key={i} width={40} height={36} />)}</div></div>
            <div className="nl-st-split"><div className="nl-st-exposure nl-skel-stack"><SkeletonBlock width={120} height={10} /><SkeletonBlock height={6} /></div><div className="nl-st-allow"><SkeletonBlock width={150} height={12} /><SkeletonBlock width={36} height={20} /></div></div>
            <div className="nl-st-status"><SkeletonBlock width={70} height={11} /><SkeletonBlock width={180} height={11} /></div>
          </section>
          <section className="nl-st-card nl-st-desk">
            <div className="nl-st-card-head"><SkeletonBlock width={110} height={14} /></div>
            <div className="nl-st-block"><SkeletonBlock width={48} height={10} /><div className="nl-st-sounds">{Array.from({ length: 5 }, (_, i) => <SkeletonBlock key={i} width={110} height={36} />)}</div></div>
            <SkeletonBlock height={6} />
            <div className="nl-st-rows">{Array.from({ length: 2 }, (_, i) => <div className="nl-st-row" key={i}><SkeletonBlock width={200} height={12} /><SkeletonBlock width={72} height={28} /></div>)}</div>
          </section>
          <section className="nl-st-card nl-st-desk">
            <div className="nl-st-card-head"><SkeletonBlock width={110} height={14} /></div>
            <div className="nl-st-block"><SkeletonBlock width={48} height={10} /><div className="nl-st-themes">{Array.from({ length: 2 }, (_, i) => <SkeletonBlock key={i} height={96} />)}</div></div>
            <div className="nl-st-block"><SkeletonBlock width={64} height={10} /><div className="nl-st-sizes">{Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} height={56} />)}</div></div>
          </section>
          <section className="nl-st-mcard nl-st-phone"><div className="nl-st-mcard-title"><SkeletonBlock width={96} height={10} /></div><div className="nl-st-mrisk"><div className="nl-st-mrisk-copy"><SkeletonBlock width={90} height={10} /><SkeletonBlock width={120} height={28} /><SkeletonBlock width={160} height={11} /></div></div><SettingsRows /><div className="nl-st-mrow"><SkeletonBlock width={134} height={13} /><SkeletonBlock width={36} height={20} /></div></section>
          {[96, 82, 64].map((width) => <section className="nl-st-mcard nl-st-phone" key={width}><div className="nl-st-mcard-title"><SkeletonBlock width={width} height={10} /></div><SettingsRows /></section>)}
        </div>
      </div>
    </div>
  );
}
