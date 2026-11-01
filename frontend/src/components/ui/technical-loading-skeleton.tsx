import styles from "@/components/technical-analyzer/technical-analyzer.module.css";
import { SkeletonBlock as Block } from "@/components/ui/ledger-loading-skeletons";

export function TechnicalLoadingSkeleton() {
  return <div className={styles.page} role="status" aria-busy="true" aria-label="Loading technical analyzer">
    <div aria-hidden="true">
      <header className={styles.header}>
        <div className="space-y-2"><Block width={120} height={12} /><h1><Block width={290} height={29} /></h1></div>
        <Block width={160} height={32} radius={6} />
      </header>
      <section className={styles.marketBar}>
        <div className={styles.pairBlock}><Block width={80} height={10} /><Block width={120} height={28} /></div>
        <div className={styles.priceBlock}><Block width={110} height={27} /><Block width={120} height={11} /></div>
        <div className={styles.timestamp}><Block width={160} height={12} /></div>
        <div className={styles.actions}><Block width={90} height={42} radius={7} /><Block width={130} height={42} radius={7} /></div>
      </section>
      <section className={styles.technicalSection}>
        <div className={styles.sectionHeading}><div className="space-y-2"><Block width={110} height={9} /><Block width={180} height={23} /></div><Block width={260} height={41} radius={8} /></div>
        <TechnicalGaugesSkeleton />
        <div className={styles.summaryNote}><Block width={560} height={12} /></div>
      </section>
      <section className={styles.outlookSection}>
        <div className={styles.sectionHeading}><div className="space-y-2"><Block width={240} height={9} /><Block width={160} height={23} /></div><Block width={150} height={11} /></div>
        <div className={`${styles.forecastCards} technical-skeleton-forecasts`}>
          {Array.from({ length: 5 }, (_, i) => <div key={i} className="technical-skeleton-forecast"><Block width={80} height={16} /><Block width={110} height={18} /><Block height={10} /><Block height={10} /><Block width={80} height={9} /><Block width={70} height={9} /></div>)}
        </div>
      </section>
    </div>
  </div>;
}

export function TechnicalGaugesSkeleton() {
  return <div className={styles.gauges} role="status" aria-busy="true" aria-label="Calculating technical indicators">
    {Array.from({ length: 3 }, (_, i) => <div key={i} aria-hidden="true" className={`${styles.gaugeCard} ${i === 1 ? styles.overall : ""}`}>
      <Block width={130} height={16} />
      <div className="technical-skeleton-gauge"><Block width="85%" height={110} radius={80} /></div>
      <Block width={120} height={24} />
      <div className={styles.counts}>{Array.from({ length: 3 }, (_, n) => <span key={n}><Block width={24} height={17} /><Block width={32} height={10} /></span>)}</div>
      <div className="border-t border-[color:var(--border)] pt-3"><Block width={120} height={12} /></div>
    </div>)}
  </div>;
}
