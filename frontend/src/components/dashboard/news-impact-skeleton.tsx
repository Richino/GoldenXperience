function Bone({ className }: { className: string }) {
  return <span className={`gx-skel max-w-full ${className}`} />;
}

export function NewsImpactSkeleton({ pairs, released }: { pairs: number; released: boolean }) {
  return (
    <div className="news-impact-drawer" role="status" aria-label="Loading news impact" aria-busy="true">
      {/* Same two columns as the loaded drawer on desktop (numbers and call,
          then the pairs); on phones both wrappers are display: contents. */}
      <div aria-hidden="true" className="contents">
        <div className="news-impact-main">
        <dl className="news-impact-values">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i}><dt><Bone className="h-2.5 w-14" /></dt><dd><Bone className="mt-1 h-4 w-14" /></dd></div>
          ))}
        </dl>
        <div className="news-impact-record"><Bone className="h-3 w-24" /><Bone className="h-[3px] flex-1" /><Bone className="h-3 w-16" /></div>
        {released ? (
          <div className="news-impact-outcome">
            <p className="news-impact-outcome-head"><Bone className="h-4 w-12" /><Bone className="h-3 w-52" /></p>
            <dl className="news-impact-summary">
              {[0, 1, 2].map((i) => <div key={i}><dt><Bone className="h-3 w-16" /></dt><dd><Bone className="h-5 w-20" /></dd></div>)}
            </dl>
          </div>
        ) : null}
        </div>
        <div className="news-impact-side">
        <h3 className="news-impact-section"><Bone className="h-2.5 w-24" /><Bone className="h-2.5 w-12" /></h3>
        <ul className="news-impact-pairs">
          {Array.from({ length: pairs }, (_, i) => (
            <li key={i}>
              <div className="news-impact-pair">
                <span className="news-impact-pair-name"><Bone className="h-5 w-9" /><Bone className="h-3.5 w-16" /></span>
                {released
                  ? <span className="news-impact-legs is-released"><Bone className="h-3.5 w-16" /><Bone className="h-3 w-28" /></span>
                  : <Bone className="h-3 w-12" />}
              </div>
            </li>
          ))}
        </ul>
        </div>
      </div>
    </div>
  );
}
