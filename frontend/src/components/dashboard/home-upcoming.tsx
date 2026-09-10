import Link from "next/link";
import type { HomeUpcomingItem } from "@/lib/home/idle";

export function HomeUpcoming({ items }: { items: HomeUpcomingItem[] }) {
  if (!items.length) return null;

  return (
    <section className="home-idle-section" aria-label="Upcoming">
      <div className="home-section-head">
        <h2>Upcoming</h2>
      </div>
      <div className="home-idle-list home-upcoming-list">
        {items.map((item) => (
          <Link
            key={item.instrument}
            href={`/chart?instrument=${item.instrument}`}
            className={`home-idle-row home-upcoming-row ${item.windowLabel === "Now" ? "is-ready" : ""}`}
          >
            <span className="home-upcoming-main">
              <span className="home-idle-pair">{item.pair}</span>
              <span className="home-upcoming-strategy">{item.strategy}</span>
            </span>
            <span className="home-upcoming-window">
              {item.windowLabel === "Now" ? "Ready now" : `Next · ${item.windowLabel}`}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
