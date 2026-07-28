export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand-mark flex items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center">
        {/* This is a local SVG mark, so load it directly instead of through the
            image optimizer, which does not reliably render SVGs in this shell. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          aria-hidden="true"
          className="brand-icon-light size-8"
          src="/brand-icon-light.svg"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          aria-hidden="true"
          className="brand-icon-dark size-8"
          src="/brand-icon.svg"
        />
      </div>
      {!compact && (
        <div className="leading-none">
          <div className="brand-wordmark text-sm font-bold tracking-[-0.045em]">
            Golden<span className="brand-wordmark-x">X</span>
            <span className="brand-wordmark-tail">perience</span>
          </div>
          <div className="brand-wordmark-sub mt-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-[color:var(--muted)]">
            Forex workspace
          </div>
        </div>
      )}
    </div>
  );
}
