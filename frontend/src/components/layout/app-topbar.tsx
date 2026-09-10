"use client";

import { useEffect, useState } from "react";
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

export function AppTopBar() {
  const [state, setState] = useState<ReturnType<typeof readCondition> | null>(null);

  useEffect(() => {
    setState(readCondition());
    const timer = window.setInterval(() => setState(readCondition()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const condition = state ?? { marketOpen: false, label: "—", clock: "— ET" };

  return (
    <header className="app-topbar" aria-label="Market status">
      <p className="app-topbar-session">
        <span
          className={`app-topbar-dot ${condition.marketOpen ? "is-open" : "is-closed"}`}
          aria-hidden="true"
        />
        <span>{condition.label}</span>
        <span className="app-topbar-clock metric-number">{condition.clock}</span>
      </p>
      <div className="app-topbar-tools">
        <TopPairSearch />
        <NotificationBell className="app-topbar-bell" />
      </div>
    </header>
  );
}
