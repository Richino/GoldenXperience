import Link from "next/link";
import { formatShortDay } from "@/lib/format/datetime";
import type { HomeActivityItem } from "@/lib/home/idle";

function rLabel(value: number | null) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "" : "";
  return `${sign}${value.toFixed(1)}R`;
}

function moneyLabel(value: number | null, currency: string) {
  if (value === null) return "—";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  if (Math.abs(value) < 0.005) return formatted;
  return `${value > 0 ? "+" : "−"}${formatted}`;
}

function signedTone(value: number | null, flat = 0.05) {
  if (value === null || Math.abs(value) < flat) return "is-flat";
  return value > 0 ? "is-positive" : "is-negative";
}

export function HomeRecentActivity({
  items,
  currency,
}: {
  items: HomeActivityItem[];
  currency: string;
}) {
  return (
    <section className="home-idle-section" aria-label="Recent activity">
      <div className="home-section-head">
        <h2>Recent activity</h2>
        <Link href="/journal" className="home-section-link">
          See all
        </Link>
      </div>
      {items.length ? (
        <div className="home-idle-list">
          <div className="home-idle-head home-activity-head" aria-hidden="true">
            <span>Pair</span>
            <span>Result</span>
            <span>P/L</span>
            <span>R</span>
            <span>Time</span>
          </div>
          {items.map((item) => {
            const href = item.instrument
              ? `/chart?instrument=${item.instrument}${item.chartTradeId ? `&trade=${item.chartTradeId}` : ""}`
              : "/journal";
            return (
              <Link
                key={item.id}
                href={href}
                className={`home-idle-row home-activity-row is-${item.kind}`}
              >
                <span className="home-idle-pair home-activity-pair">{item.pair}</span>
                <span className="home-activity-result">{item.label}</span>
                <span className={`home-activity-money metric-number ${signedTone(item.paperPl, 0.005)}`}>
                  {moneyLabel(item.paperPl, currency)}
                </span>
                <span className={`home-activity-r metric-number ${signedTone(item.resultR)}`}>{rLabel(item.resultR)}</span>
                <span className="home-activity-time">{formatShortDay(item.at)}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="home-empty">No closed trades yet.</p>
      )}
    </section>
  );
}
