import type { IndicatorReading, TechnicalRating } from "@/lib/technical-analyzer/types";
import styles from "./technical-analyzer.module.css";

const colors = ["#df5365", "#e48a97", "#8f9aaa", "#72a5ed", "#347dea"];
const point = (angle: number, radius = 101) => [140 + radius * Math.cos(angle * Math.PI / 180), 136 - radius * Math.sin(angle * Math.PI / 180)];
const tone = (label: string) => label.includes("Sell") ? styles.sell : label.includes("Buy") ? styles.buy : styles.neutral;

export function TechnicalGauge({ title, rating, rows, precision, prominent = false }: {
  title: string; rating: TechnicalRating; rows: IndicatorReading[]; precision: number; prominent?: boolean;
}) {
  const needle = point(90 * (1 - rating.score), 79);
  return <article className={`${styles.gaugeCard} ${prominent ? styles.overall : ""}`} aria-label={title}>
    <h3>{title}</h3>
    <svg viewBox="0 0 280 185" role="img" aria-label={`${title}: ${rating.label}; ${rating.sell} sell, ${rating.neutral} neutral, ${rating.buy} buy`}>
      {colors.map((color, i) => {
        const start = point(178 - i * 36), end = point(146 - i * 36);
        return <path key={color} d={`M${start[0]},${start[1]} A101,101 0 0,1 ${end[0]},${end[1]}`} fill="none" stroke={color} strokeWidth="12" />;
      })}
      <text x="140" y="16" textAnchor="middle">Neutral</text>
      <text x="43" y="50" textAnchor="middle">Sell</text><text x="237" y="50" textAnchor="middle">Buy</text>
      <text x="30" y="162" textAnchor="middle">Strong Sell</text><text x="250" y="162" textAnchor="middle">Strong Buy</text>
      <line x1="140" y1="136" x2={needle[0]} y2={needle[1]} className={styles.needle} />
      <circle cx="140" cy="136" r="6" className={styles.needleHub} />
    </svg>
    <strong className={`${styles.ratingLabel} ${tone(rating.label)}`}>{rating.label}</strong>
    <div className={styles.counts}><span><b className={styles.sell}>{rating.sell}</b>Sell</span><span><b>{rating.neutral}</b>Neutral</span><span><b className={styles.buy}>{rating.buy}</b>Buy</span></div>
    <details><summary>View {rows.length} readings</summary><div className={styles.tableScroll}><table><thead><tr><th>Indicator</th><th>Value</th><th>Action</th></tr></thead><tbody>{rows.map(r => <tr key={r.name}><td><span>{r.name}</span><details className={styles.rule}><summary>Rule</summary>{r.rule}</details></td><td>{r.value.toFixed(r.name.startsWith("EMA") || r.name.startsWith("SMA") ? precision : r.name.startsWith("MACD") || r.name.startsWith("Momentum") || r.name.startsWith("Awesome") ? 6 : 2)}{r.extra && <small>{r.extra}</small>}</td><td className={tone(r.action)}>{r.action}</td></tr>)}</tbody></table></div></details>
  </article>;
}
