function Bone({ className }: { className: string }) {
  return <span className={`gx-skel max-w-full ${className}`} />;
}

export function NewsImpactSkeleton({ pairs, released }: { pairs: number; released: boolean }) {
  return (
    <div className="news-impact-drawer" role="status" aria-label="Loading news impact" aria-busy="true">
      <div aria-hidden="true" className="contents">
        <dl className="news-impact-values">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i}><dt><Bone className="h-3 w-16" /></dt><dd><Bone className="h-6 w-16" /></dd></div>
          ))}
        </dl>
        <div className="news-impact-record"><Bone className="h-3 w-24" /><Bone className="h-1 flex-1" /><Bone className="h-3 w-14" /></div>
        {released ? (
          <div className="news-impact-outcome">
            <p className="news-impact-outcome-head"><Bone className="h-4 w-12" /><Bone className="h-3 w-52" /></p>
            <dl className="news-impact-summary">
              {[0, 1].map((i) => <div key={i}><dt><Bone className="h-3 w-20" /></dt><dd><Bone className="h-5 w-24" /></dd></div>)}
            </dl>
          </div>
        ) : null}
        <h3 className="news-impact-section"><Bone className="h-3 w-40" /><Bone className="h-3 w-12" /></h3>
        <ul className="news-impact-pairs">
          {Array.from({ length: pairs }, (_, i) => (
            <li key={i}>
              <div className="news-impact-pair">
                <span className="news-impact-pair-name"><Bone className="h-6 w-9 rounded-full" /><Bone className="h-4 w-20" /></span>
                <span className="news-impact-legs is-released"><Bone className="h-5 w-20" /><Bone className="h-4 w-36 rounded-full" /></span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
