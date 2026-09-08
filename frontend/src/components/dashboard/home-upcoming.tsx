import Link from "next/link";
import type { HomeUpcomingItem } from "@/lib/home/idle";

export function HomeUpcoming({ items }: { items: HomeUpcomingItem[] }) {
  if (!items.length) return null;

  return (
    <section className="home-idle-section" aria-label="Upcoming">
      <div className="home-section-head">
        <h2>Upcoming</h2>
      </div>
      <div className="home-idle-list">
        <div className="home-idle-head" aria-hidden="true">
          <span>Pair</span>
          <span>Strategy</span>
          <span>Next window</span>
        </div>
        {items.map((item) => (
          <Link
            key={item.instrument}
            href={`/chart?instrument=${item.instrument}`}
            className="home-idle-row home-upcoming-row"
          >
            <span className="home-idle-pair">{item.pair}</span>
            <span>{item.strategy}</span>
            <span>{item.windowLabel}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
