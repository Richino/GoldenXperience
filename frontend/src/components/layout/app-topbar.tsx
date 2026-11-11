"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { TopPairSearch } from "@/components/layout/top-pair-search";
import { formatEtClock } from "@/lib/format/datetime";
import { getMarketCondition } from "@/lib/strategy/session";

function readCondition(now = new Date()) {
  const condition = getMarketCondition(now);
  return {
    ...condition,
    clock: formatEtClock(now),
  };
}

const PAGE_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "/chart", label: "Chart" },
  { prefix: "/journal", label: "Trades" },
  { prefix: "/watchlist", label: "Markets" },
  { prefix: "/research", label: "Performance" },
  { prefix: "/risk", label: "More" },
  { prefix: "/settings", label: "Settings" },
];

function pageLabel(pathname: string) {
  if (pathname === "/") return "Home";
  return PAGE_LABELS.find((entry) => pathname.startsWith(entry.prefix))?.label ?? "Home";
}

export function AppTopBar() {
  const pathname = usePathname();
  const [state, setState] = useState<ReturnType<typeof readCondition> | null>(null);

  useEffect(() => {
    // Client-only clock; server and first client render agree on the null
    // placeholder, so seeding it here is the intent, not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(readCondition());
    const timer = window.setInterval(() => setState(readCondition()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const condition = state ?? { marketOpen: false, label: "—", clock: "— ET" };
  const page = pageLabel(pathname);

  return (
    <header className="app-topbar" aria-label="Market status">
      <p className="app-topbar-session">
        <span className="app-topbar-page">{page}</span>
        <span
          className={`app-topbar-dot ${condition.marketOpen ? "is-open" : "is-closed"}`}
          aria-hidden="true"
        />
        <span className="app-topbar-status">
          {condition.marketOpen ? "Market open" : "Market closed"}
        </span>
        {condition.marketOpen && state ? (
          <>
            <span className="app-topbar-sep" aria-hidden="true">
              •
            </span>
            <span className="app-topbar-market-session">{condition.label}</span>
          </>
        ) : null}
        <span className="app-topbar-clock metric-number">{condition.clock}</span>
      </p>
      <div className="app-topbar-tools">
        <TopPairSearch />
        <NotificationBell className="app-topbar-bell" />
      </div>
    </header>
  );
}
