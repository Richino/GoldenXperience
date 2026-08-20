"use client";

import { useEffect, useState } from "react";
import { WatchlistView } from "@/components/watchlist/watchlist-view";
import { BinaryWatchlistView } from "@/components/watchlist/binary-watchlist-view";
import { MultiStrategyView } from "@/components/watchlist/multistrategy-view";

type Tab = "trading" | "strategies" | "binary";

/** Flip to true to show the forex Trading tab again. Still reachable via `?tab=trading`. */
const SHOW_TRADING_TAB = false;

const TAB_LABEL: Record<Tab, string> = { trading: "Trading", strategies: "Strategies", binary: "Binary" };

const VISIBLE_TABS: readonly Tab[] = SHOW_TRADING_TAB
  ? (["trading", "strategies", "binary"] as const)
  : (["strategies", "binary"] as const);

function isTab(value: string | null): value is Tab {
  return value === "trading" || value === "strategies" || value === "binary";
}

function watchlistPanel(tab: Tab) {
  switch (tab) {
    case "trading":
      return <WatchlistView />;
    case "strategies":
      return <MultiStrategyView />;
    case "binary":
      return <BinaryWatchlistView />;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

/**
 * The Watchlist page shell: a Strategies | Binary switch (Trading is hidden
 * for now). Strategies shows the four multi-strategy candidates per pair and
 * the adaptive engine's pick; Binary shows the prediction engine's monitored
 * symbols. The initial tab honours a `?tab=strategies` / `?tab=binary` /
 * `?tab=trading` deep link.
 */
export function WatchlistTabs() {
  const [tab, setTab] = useState<Tab>("strategies");

  useEffect(() => {
    // One-time sync of the initial tab from the URL (an external system).
    const requested = new URLSearchParams(window.location.search).get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isTab(requested)) setTab(requested);
  }, []);

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Watchlist mode" className="binary-seg flex gap-1.5">
        {VISIBLE_TABS.map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`check-chip pressable ${tab === value ? "check-chip-active" : ""}`}
          >
            {TAB_LABEL[value]}
          </button>
        ))}
      </div>
      {watchlistPanel(tab)}
    </div>
  );
}
