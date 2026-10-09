/** Uses Home's layout classes so its loading state follows the same breakpoints. */
function Placeholder({ className = "" }: { className?: string }) {
  return <span className={`gx-skel max-w-full ${className}`} />;
}

function SectionHeading() {
  return (
    <div className="nl-sec-head">
      <div className="nl-sec-title">
        <Placeholder className="nl-sec-num h-3 w-4" />
        <Placeholder className="h-6 w-40 lg:h-8" />
        <Placeholder className="h-5 w-7 rounded-full" />
      </div>
      <Placeholder className="h-4 w-12" />
    </div>
  );
}

function Levels() {
  return (
    <dl className="nl-levels">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index}>
          <dt><Placeholder className="h-3 w-9" /></dt>
          <dd><Placeholder className="h-4 w-16" /></dd>
        </div>
      ))}
    </dl>
  );
}

export function HomeLoadingSkeleton() {
  return (
    <div className="nl-home nl-home-skeleton" aria-busy="true" aria-label="Loading home">
      <header className="nl-home-top" aria-hidden="true">
        <div className="nl-home-greet">
          <Placeholder className="h-3 w-28" />
          <Placeholder className="h-7 w-44" />
        </div>
        <div className="nl-home-tools">
          <Placeholder className="h-10 w-48 rounded-xl" />
          <Placeholder className="h-10 w-60 rounded-full" />
          <Placeholder className="size-11 rounded-xl" />
        </div>
      </header>
      <div className="nl-home-body" aria-hidden="true">
        <header className="nl-home-mtop">
          <div className="nl-home-mtop-ident">
            <div className="nl-home-mtop-copy">
              <Placeholder className="h-[27px] w-40" />
              <Placeholder className="h-[18px] w-44" />
            </div>
          </div>
          <Placeholder className="size-11 rounded-[13px]" />
        </header>
        <section className="nl-hero">
          <div className="nl-hero-copy">
            <span className="nl-overline"><Placeholder className="h-[16.5px] w-28 lg:h-[18px]" /></span>
            <div className="nl-hero-balance"><Placeholder className="h-[0.9em] w-[5.1em] rounded-xl" /></div>
            <div className="nl-hero-change">
              <Placeholder className="h-8 w-24 rounded-full" />
              <Placeholder className="h-4 w-28" />
              <Placeholder className="nl-hero-open h-4 w-48" />
            </div>
          </div>
          <div className="nl-range-tabs">
            {Array.from({ length: 5 }, (_, index) => (
              <Placeholder key={index} className="h-10 w-full rounded-[10px] lg:w-[52px]" />
            ))}
          </div>
          <div className="nl-chart-card">
            <Placeholder className="h-full w-full rounded-none lg:rounded-xl" />
          </div>
          <dl className="nl-stats">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index}>
                <dt><Placeholder className="h-[18px] w-28 lg:h-[19.5px]" /></dt>
                <dd><Placeholder className="h-[27px] w-24 lg:h-9" /></dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="nl-home-cols">
          <div className="nl-home-main">
            <section className="nl-sec nl-positions">
              <SectionHeading />
              <div className="nl-pos-head">
                {Array.from({ length: 6 }, (_, index) => <Placeholder key={index} className="h-3 w-14" />)}
              </div>
              {Array.from({ length: 2 }, (_, index) => (
                <div key={index} className="nl-pos">
                  <div className="nl-pos-pair">
                    <Placeholder className="h-6 w-24" />
                    <Placeholder className="h-4 w-32" />
                  </div>
                  <div className="nl-pos-prices"><Placeholder className="h-4 w-28" /></div>
                  <div className="nl-pos-track space-y-2">
                    <Placeholder className="h-1 w-full rounded-full" />
                    <div className="flex justify-between gap-2"><Placeholder className="h-3 w-16" /><Placeholder className="h-3 w-16" /></div>
                  </div>
                  <div className="nl-pos-size"><Placeholder className="h-4 w-16" /></div>
                  <div className="nl-pos-r"><Placeholder className="ml-auto h-3 w-12" /></div>
                  <div className="nl-pos-pl"><Placeholder className="ml-auto h-6 w-20" /></div>
                </div>
              ))}
            </section>
            <section className="nl-sec nl-setups">
              <SectionHeading />
              <div className="nl-setup-grid">
                {Array.from({ length: 2 }, (_, index) => (
                  <div key={index} className="nl-setup">
                    <div className="nl-setup-top"><Placeholder className="h-6 w-24" /><Placeholder className="h-3 w-12" /></div>
                    <Levels />
                  </div>
                ))}
              </div>
            </section>
            <section className="nl-card nl-pending">
              <div className="nl-card-head"><Placeholder className="h-6 w-24" /><Placeholder className="h-3 w-12" /></div>
              <div className="nl-pending-entry">
                <div className="nl-pending-top"><Placeholder className="h-6 w-24" /><Placeholder className="h-5 w-12" /></div>
                <Levels />
                <div className="nl-pending-foot"><Placeholder className="h-3 w-20" /><Placeholder className="h-8 w-16 rounded-full" /></div>
              </div>
            </section>
            <section className="nl-sec nl-activity">
              <SectionHeading />
              <div className="nl-activity-list">
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="nl-activity-row">
                    <Placeholder className="h-4 w-20" />
                    <Placeholder className="nl-activity-label h-3 w-20" />
                    <Placeholder className="ml-auto h-4 w-16" />
                    <Placeholder className="ml-auto h-4 w-10" />
                    <Placeholder className="nl-activity-time ml-auto h-3 w-12" />
                  </div>
                ))}
              </div>
            </section>
          </div>
          <aside className="nl-home-aside">
            <section className="nl-today">
              <div className="nl-today-head"><Placeholder className="h-4 w-28" /><Placeholder className="h-4 w-12" /></div>
              <div className="nl-today-main">
                <Placeholder className="h-10 w-44 lg:h-14" />
                <Placeholder className="h-10 w-full rounded-md" />
              </div>
              <dl className="nl-today-meta">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index}><dt><Placeholder className="h-3 w-12" /></dt><dd><Placeholder className="h-6 w-12" /></dd></div>
                ))}
              </dl>
            </section>
            <section className="nl-card nl-news">
              <div className="nl-card-head"><Placeholder className="h-6 w-36" /><Placeholder className="h-3 w-5" /></div>
              <div className="nl-news-list">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="nl-news-row">
                    <div className="space-y-2"><Placeholder className="h-3 w-8" /><Placeholder className="h-4 w-10" /></div>
                    <div className="min-w-0 flex-1 space-y-2"><Placeholder className="h-4 w-full" /><Placeholder className="h-3 w-20" /></div>
                    <Placeholder className="h-5 w-8" />
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
