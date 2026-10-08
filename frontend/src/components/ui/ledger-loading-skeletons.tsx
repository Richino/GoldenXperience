import type { CSSProperties } from "react";

/** Quiet placeholders; layout comes from the same classes as the loaded pages. */
export function SkeletonBlock({ width = "100%", height = 14, radius = 6, className = "" }: {
  width?: CSSProperties["width"]; height?: CSSProperties["height"]; radius?: number; className?: string;
}) {
  return <span aria-hidden="true" className={`gx-skel max-w-full ${className}`} style={{ width, height, borderRadius: radius }} />;
}

function SkeletonTitle({ page }: { page: "tr" | "mk" | "st" }) {
  return (
    <div className={`nl-${page}-title`}>
      <span className="nl-overline"><SkeletonBlock width={132} height={12} /></span>
      <h1><SkeletonBlock width="4.5em" height="0.9em" radius={10} /></h1>
    </div>
  );
}

export function TradesSummarySkeleton() {
  return (
    <section className="nl-tr-summary" aria-hidden="true">
      <div className="nl-tr-hero">
        <span className="nl-tr-hero-label"><SkeletonBlock width={168} height={18} /></span>
        <span className="nl-tr-hero-value"><SkeletonBlock width="4.8em" height="0.9em" radius={8} /></span>
        <span className="nl-tr-hero-sub"><SkeletonBlock width={180} height={18} /></span>
        <span className="nl-tr-hero-bars"><SkeletonBlock height={64} /></span>
      </div>
      <div className="nl-tr-barcard">
        <div className="nl-tr-barcard-head"><SkeletonBlock width={200} /><SkeletonBlock width={44} /></div>
        <SkeletonBlock height={104} radius={12} />
      </div>
      <dl className="nl-tr-stats">
        {Array.from({ length: 4 }, (_, i) => <div key={i}><dt><SkeletonBlock width={54} height={18} /></dt><dd><SkeletonBlock width={64} height={27} /></dd></div>)}
      </dl>
    </section>
  );
}

export function TradesToolbarSkeleton({ showFilters = false }: { showFilters?: boolean }) {
  return (
    <div className="nl-tr-toolbar nl-skeleton-toolbar" aria-hidden="true">
      <div className="nl-tr-tabs">{Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} width={104} height={40} radius={10} />)}</div>
      {showFilters ? <div className="nl-tr-filters">{[48, 60, 68].map((w) => <SkeletonBlock key={w} width={w} height={36} radius={999} />)}</div> : null}
      <div className="nl-tr-search"><SkeletonBlock width={18} height={18} /><SkeletonBlock width={100} /></div>
    </div>
  );
}

export function TradesSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className="nl-tr-rowhead">
        {["", "nl-tr-hide-md", "nl-tr-hide-sm", "nl-tr-hide-sm", "", "", "nl-tr-hide-md", "nl-tr-hide-md nl-tr-hide-sm"].map((c, i) => <SkeletonBlock key={i} className={c} width={i === 0 ? 60 : 40} height={12} />)}
      </div>
      <div className="nl-tr-rows">
        {Array.from({ length: rows }, (_, i) => <div className="nl-tr-row" key={i}>
          <span className="nl-tr-pair"><SkeletonBlock width={88} height={18} /><SkeletonBlock width={38} height={20} /></span>
          <SkeletonBlock className="nl-tr-hide-md" width={84} />
          <SkeletonBlock className="nl-tr-hide-sm" width={64} />
          <SkeletonBlock className="nl-tr-hide-sm" width={64} />
          <SkeletonBlock width={44} height={24} /><SkeletonBlock width={64} />
          <SkeletonBlock className="nl-tr-hide-md" width={40} /><SkeletonBlock className="nl-tr-hide-md nl-tr-hide-sm" width={78} />
        </div>)}
      </div>
      <div className="nl-tr-cards">
        {Array.from({ length: rows }, (_, i) => <div className="nl-tr-card" key={i}>
          <span className="nl-tr-card-top"><span className="nl-tr-pair"><SkeletonBlock width={90} height={22} /><SkeletonBlock width={38} height={22} /></span><SkeletonBlock width={76} height={20} /></span>
          <span className="nl-tr-card-meta"><SkeletonBlock width={160} height={18} /><SkeletonBlock width={54} height={24} /></span>
        </div>)}
      </div>
    </div>
  );
}

export function LedgerTradesLoadingSkeleton() {
  return (
    <div className="nl-tr" aria-busy="true" aria-label="Loading trades">
      <header className="nl-tr-head" aria-hidden="true"><SkeletonTitle page="tr" /><SkeletonBlock width={44} height={44} radius={13} /></header>
      <TradesSummarySkeleton />
      <TradesToolbarSkeleton />
      <div className="nl-tr-body" aria-hidden="true">
        <section className="nl-tr-list"><TradesSkeleton /></section>
        <aside className="nl-tr-panel"><SkeletonBlock width={180} /></aside>
      </div>
    </div>
  );
}

export function MarketRowSkeleton() {
  return (
    <div className="nl-mk-row nl-mk-row-loading" aria-hidden="true">
      <span className="nl-mk-pair">
        <SkeletonBlock className="nl-mk-coins" width={40} height={28} radius={999} />
        <span className="nl-mk-pair-copy">
          <SkeletonBlock width={86} height={18} />
          <SkeletonBlock width={160} height={16} />
        </span>
      </span>
      <SkeletonBlock className="nl-mk-row-spark nl-mk-hide-md" height={28} />
      <span className="nl-mk-price">
        <SkeletonBlock width={66} />
        <SkeletonBlock className="nl-mk-narrow-change" width={42} height={12} />
      </span>
      <SkeletonBlock className="nl-mk-hide-sm" width={58} />
      <SkeletonBlock className="nl-mk-hide-sm" height={20} />
      <SkeletonBlock className="nl-mk-spread nl-mk-hide-md" width={42} />
      <span className="nl-mk-analyze nl-skeleton-market-action">
        <SkeletonBlock width={20} height={20} />
      </span>
    </div>
  );
}

export function LedgerWatchlistPairsSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading markets">
      <div className="nl-mk-rowhead" aria-hidden="true">
        {["", "nl-mk-hide-md", "", "nl-mk-hide-sm", "nl-mk-hide-sm", "nl-mk-hide-md", ""].map((c, i) => <SkeletonBlock key={i} className={c} width={48} height={12} />)}
      </div>
      <div className="nl-mk-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => <MarketRowSkeleton key={i} />)}
      </div>
    </div>
  );
}

export function LedgerMarketsLoadingSkeleton() {
  return (
    <div className="nl-mk" aria-busy="true" aria-label="Loading markets">
      <header className="nl-mk-head" aria-hidden="true">
        <SkeletonTitle page="mk" /><span className="nl-mk-bell"><SkeletonBlock width={20} height={20} /></span>
        <div className="nl-session-strip">
          <div className="nl-session-strip-head"><SkeletonBlock width={100} height={20} /><SkeletonBlock width={64} /></div>
          <div className="nl-session-strip-lanes">{Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} height={12} />)}</div>
          <div className="nl-session-strip-scale"><SkeletonBlock height={12} /></div>
        </div>
      </header>
      <section className="nl-mk-all">
        <div className="nl-mk-toolbar nl-skeleton-toolbar" aria-hidden="true">
          <h2><SkeletonBlock width={78} height={22} /></h2>
          <div className="nl-mk-groups">{[46, 70, 104, 114].map((w) => <SkeletonBlock key={w} width={w} height={36} radius={999} />)}</div>
          <div className="nl-mk-sorts">{[76, 86, 36].map((w) => <SkeletonBlock key={w} width={w} height={32} />)}</div>
          <div className="nl-mk-search"><SkeletonBlock width={18} height={18} /><SkeletonBlock width={126} /></div>
        </div>
        <LedgerWatchlistPairsSkeleton />
      </section>
    </div>
  );
}

function SettingsRows({ count = 2 }: { count?: number }) {
  return <>{Array.from({ length: count }, (_, i) => <div className="nl-st-mrow" key={i}><SkeletonBlock width={124} height={20} /><SkeletonBlock width={72} height={20} /></div>)}</>;
}

export function LedgerSettingsLoadingSkeleton() {
  return (
    <div className="nl-st" aria-busy="true" aria-label="Loading settings">
      <header className="nl-st-head" aria-hidden="true"><SkeletonTitle page="st" /></header>
      <div className="nl-st-layout" aria-hidden="true">
        <div className="nl-st-index nl-st-desk">{Array.from({ length: 4 }, (_, i) => <div className="nl-skeleton-index" key={i}><SkeletonBlock width={16} /><SkeletonBlock width={116} /></div>)}</div>
        <div className="nl-st-content">
          <section className="nl-st-card is-risk nl-st-desk">
            <div className="nl-st-card-head"><div className="space-y-2"><SkeletonBlock width={70} height={38} /><SkeletonBlock width={208} height={20} /></div></div>
            <div className="nl-st-risk-hero"><div className="nl-st-risk-main"><SkeletonBlock width={96} height={20} /><SkeletonBlock width={240} height={62} /><SkeletonBlock width={260} height={20} /></div><div className="nl-st-presets">{Array.from({ length: 4 }, (_, i) => <SkeletonBlock key={i} width={88} height={48} radius={14} />)}</div></div>
            <div className="nl-st-block"><SkeletonBlock width={138} height={22} /><div className="nl-st-positions">{Array.from({ length: 11 }, (_, i) => <SkeletonBlock key={i} width={i === 10 ? 108 : 48} height={48} radius={14} />)}</div></div>
            <div className="nl-st-split"><div className="nl-st-exposure space-y-2"><SkeletonBlock width={150} height={22} /><SkeletonBlock height={48} /><SkeletonBlock height={18} /></div><div className="nl-st-allow"><SkeletonBlock width={160} height={46} /><SkeletonBlock width={48} height={28} radius={999} /></div></div>
            <div className="nl-st-status"><SkeletonBlock width={80} height={28} /><SkeletonBlock width={160} /></div>
          </section>
          <section className="nl-st-card nl-st-desk"><SkeletonBlock width={210} height={38} /><div className="nl-st-sounds">{Array.from({ length: 5 }, (_, i) => <SkeletonBlock key={i} width={154} height={48} radius={14} />)}</div><SkeletonBlock height={36} /><div className="nl-st-rows">{Array.from({ length: 3 }, (_, i) => <div className="nl-st-row" key={i}><SkeletonBlock width={230} height={42} /><SkeletonBlock width={90} height={40} /></div>)}</div></section>
          <section className="nl-st-card nl-st-desk"><SkeletonBlock width={160} height={38} /><div className="nl-st-themes">{Array.from({ length: 2 }, (_, i) => <SkeletonBlock key={i} height={140} radius={16} />)}</div><div className="nl-st-sizes">{Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} height={96} radius={16} />)}</div></section>
          <section className="nl-st-card nl-st-desk"><SkeletonBlock width={120} height={38} /><div className="nl-st-account"><SkeletonBlock height={60} /></div><SkeletonBlock width={120} height={44} /></section>
          <section className="nl-st-mcard nl-st-phone"><div className="nl-st-mcard-title"><SkeletonBlock width={108} height={16} /></div><div className="nl-st-mrisk"><div className="nl-st-mrisk-copy"><SkeletonBlock width={96} height={18} /><SkeletonBlock width={136} height={42} /><SkeletonBlock width={172} height={18} /></div><SkeletonBlock width={16} height={16} /></div><SettingsRows /><div className="nl-st-mrow"><div className="space-y-1 py-2.5"><SkeletonBlock width={134} height={20} /><SkeletonBlock width={200} height={18} /></div><SkeletonBlock width={48} height={28} radius={999} /></div></section>
          {[110, 94, 70].map((width) => <section className="nl-st-mcard nl-st-phone" key={width}><div className="nl-st-mcard-title"><SkeletonBlock width={width} height={16} /></div><SettingsRows /></section>)}
        </div>
      </div>
    </div>
  );
}
