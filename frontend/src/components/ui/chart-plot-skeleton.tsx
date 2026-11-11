import styles from "./chart-plot-skeleton.module.css";

export function ChartPlotSkeleton() {
  return (
    <div className={`chart-loading-skeleton ${styles.plot}`} aria-hidden="true">
      <div className={styles.grid} />
      <div className={styles.priceAxis}>{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</div>
      <div className={styles.timeAxis}>{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>
    </div>
  );
}
