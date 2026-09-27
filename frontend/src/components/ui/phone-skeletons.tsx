/**
 * Phone loading skeletons for the four dock tabs. Each mirrors the page's
 * phone layout block for block (the app-style cards), so nothing jumps when
 * the real content replaces it. Shown below the lg breakpoint only; the
 * desktop skeletons in page-skeletons.tsx cover wider screens.
 */

function Skel({ w, h, r, className = "", grow = false }: { w?: number | string; h: number; r?: number; className?: string; grow?: boolean }) {
  return (
    <span
      aria-hidden
      className={`gx-skel ${className}`}
      style={{ width: grow ? undefined : typeof w === "number" ? `${w}px` : w, height: `${h}px`, borderRadius: r === undefined ? undefined : `${r}px`, flex: grow ? 1 : undefined }}
    />
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`phone-skel-card ${className}`}>{children}</div>;
}

function Row({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`phone-skel-row ${className}`}>{children}</div>;
}

function Stack({ children, gap = 6, className = "" }: { children: React.ReactNode; gap?: number; className?: string }) {
  return <div className={`phone-skel-stack ${className}`} style={{ gap: `${gap}px` }}>{children}</div>;
}

/* ------------------------------------------------------------------- Home */

export function PhoneHomeSkeleton() {
  return (
    <div className="phone-skel-page gx-phone-only" aria-busy aria-label="Loading home">
      <Card className="is-hero">
        <Row>
          <Skel w={118} h={26} r={999} />
          <Skel w={40} h={40} r={999} />
        </Row>
        <Skel w={230} h={40} r={8} className="phone-skel-gap-12" />
        <Skel w={170} h={15} className="phone-skel-gap-12" />
        <Skel w="100%" h={47} r={12} className="phone-skel-gap-20" />
        <Skel w="100%" h={190} r={10} className="phone-skel-gap-16" />
        <div className="phone-skel-divider" />
        <Row className="is-start">
          <Stack><Skel w={64} h={10} /><Skel w={72} h={15} /></Stack>
          <Stack><Skel w={76} h={10} /><Skel w={72} h={15} /></Stack>
        </Row>
      </Card>

      <Card>
        <Skel w={110} h={10} />
        <Skel w={150} h={13} className="phone-skel-gap-12" />
      </Card>

      <Card>
        <Row>
          <Skel w={120} h={10} />
          <Skel w={44} h={10} />
        </Row>
        {Array.from({ length: 5 }, (_, index) => (
          <Row key={index} className="is-list-row">
            <Stack><Skel w={70} h={13} /><Skel w={130} h={11} /></Stack>
            <Stack className="is-end"><Skel w={72} h={14} /><Skel w={42} h={10} /></Stack>
          </Row>
        ))}
      </Card>

      <Card>
        <Skel w={52} h={10} />
        <Row className="phone-skel-gap-12">
          <Skel w={96} h={24} r={6} />
          <Skel w={44} h={22} r={999} />
        </Row>
        <Skel w={140} h={12} className="phone-skel-gap-10" />
        <div className="phone-skel-divider" />
        <Row>
          <Stack><Skel w={46} h={9} /><Skel w={24} h={14} /></Stack>
          <Stack className="is-center"><Skel w={30} h={9} /><Skel w={36} h={14} /></Stack>
          <Stack className="is-end"><Skel w={54} h={9} /><Skel w={32} h={14} /></Stack>
        </Row>
        <Skel w="100%" h={4} r={999} className="phone-skel-gap-14" />
      </Card>

      <Card>
        <Row>
          <Skel w={120} h={10} />
          <Skel w={28} h={28} r={999} />
        </Row>
        <Skel w="92%" h={12} className="phone-skel-gap-12" />
        <Skel w="60%" h={12} className="phone-skel-gap-6" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Chart */

export function PhoneChartHeaderSkeleton() {
  return (
    <div className="phone-skel-chart-head" aria-hidden>
      <Row>
        <Skel w={96} h={18} r={6} />
        <Row className="is-tight">
          <Skel w={40} h={40} r={999} />
          <Skel w={40} h={40} r={999} />
        </Row>
      </Row>
      <Row className="is-baseline">
        <Row className="is-tight">
          <Skel w={110} h={24} r={6} />
          <Skel w={96} h={11} />
        </Row>
        <Skel w={88} h={10} />
      </Row>
      <div className="phone-skel-rail">
        {Array.from({ length: 5 }, (_, index) => <Skel key={index} h={33} r={7} grow />)}
      </div>
    </div>
  );
}

export function PhoneChartFooterSkeleton() {
  return (
    <div className="phone-skel-chart-foot" aria-hidden>
      <div className="phone-skel-tools">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className="phone-skel-tool"><Skel w={22} h={22} r={6} /></span>
        ))}
      </div>
      <div className="phone-skel-trade"><Skel w="100%" h={46} r={12} /></div>
    </div>
  );
}

/* ----------------------------------------------------------------- Trades */

export function TradesSummarySkeleton() {
  return (
    <div className="trades-summary trades-summary-skeleton" aria-hidden>
      {Array.from({ length: 4 }, (_, index) => (
        <span key={index} className="trades-summary-skeleton-item">
          <i className="is-value" />
          <i className="is-label" />
        </span>
      ))}
    </div>
  );
}

export function TradesToolbarSkeleton() {
  return (
    <div className="trades-toolbar-skeleton" aria-hidden>
      <span className="trades-toolbar-skeleton-tabs" />
      <span className="trades-toolbar-skeleton-search" />
      <span className="trades-toolbar-skeleton-filters">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

/** Desktop: plain table rows. Phone: trade-card shaped (see globals.css). */
export function TradesSkeleton() {
  return (
    <div className="trades-skeleton" aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="trades-skeleton-row">
          <span className="is-top"><i className="is-pair" /><i className="is-r" /></span>
          <span className="is-sub"><i className="is-meta" /><i className="is-badge" /></span>
          <span className="is-flow"><i /></span>
          <span className="is-foot"><i className="is-date" /><i className="is-money" /></span>
        </div>
      ))}
    </div>
  );
}

export function PhoneTradesSkeleton() {
  return (
    <div className="trades-view gx-phone-only" aria-busy aria-label="Loading trades">
      <section className="trades-overview">
        <header className="trades-header">
          <Skel w={120} h={30} r={8} />
        </header>
        <TradesSummarySkeleton />
      </section>
      <div className="trades-body">
        <div className="trades-workspace">
          <TradesToolbarSkeleton />
          <TradesSkeleton />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Settings */

function SettingsRowSkeleton({ label, value, last = false }: { label: number; value: number; last?: boolean }) {
  return (
    <Row className={`is-settings-row${last ? " is-last" : ""}`}>
      <Skel w={label} h={14} />
      <Skel w={value} h={12} />
    </Row>
  );
}

export function PhoneSettingsSkeleton() {
  return (
    <div className="phone-skel-page gx-phone-only" aria-busy aria-label="Loading settings">
      <Stack gap={8}>
        <Skel w={130} h={30} r={8} />
        <Skel w={210} h={13} />
      </Stack>

      <Card>
        <Skel w={86} h={10} />
        <SettingsRowSkeleton label={60} value={52} />
        <SettingsRowSkeleton label={70} value={70} last />
      </Card>

      <Card>
        <Skel w={100} h={10} />
        <SettingsRowSkeleton label={132} value={84} />
        <SettingsRowSkeleton label={84} value={52} last />
      </Card>

      <Card>
        <Row className="is-start">
          <Stack gap={8}><Skel w={104} h={10} /><Skel w={150} h={11} /></Stack>
          <Skel w={62} h={11} />
        </Row>
        <Skel w={84} h={11} className="phone-skel-gap-18" />
        <Skel w="100%" h={46} r={12} className="phone-skel-gap-8" />
        <SettingsRowSkeleton label={130} value={74} />
        <Skel w={104} h={11} className="phone-skel-gap-18" />
        <Skel w="100%" h={46} r={12} className="phone-skel-gap-8" />
        <div className="phone-skel-divider is-wide" />
        <Row>
          <Skel w={126} h={14} />
          <Skel w={51} h={31} r={999} />
        </Row>
      </Card>

      <Card>
        <Skel w={70} h={10} />
        <SettingsRowSkeleton label={86} value={160} last />
        <Skel w="100%" h={44} r={12} className="phone-skel-gap-14" />
      </Card>
    </div>
  );
}
