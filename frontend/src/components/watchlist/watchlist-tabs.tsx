"use client";

import { useEffect, useState } from "react";
import { WatchlistView } from "@/components/watchlist/watchlist-view";
import { MultiStrategyView } from "@/components/watchlist/multistrategy-view";

type Tab = "trading" | "strategies";

/** Flip to true to show the forex Trading tab again. Still reachable via `?tab=trading`. */
const SHOW_TRADING_TAB = false;

const TAB_LABEL: Record<Tab, string> = { trading: "Trading", strategies: "Strategies" };

const VISIBLE_TABS: readonly Tab[] = SHOW_TRADING_TAB
  ? (["trading", "strategies"] as const)
  : (["strategies"] as const);

function isTab(value: string | null): value is Tab {
  return value === "trading" || value === "strategies";
}

function watchlistPanel(tab: Tab) {
  switch (tab) {
    case "trading":
      return <WatchlistView />;
    case "strategies":
      return <MultiStrategyView />;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

/** Binary collection is retired; historical predictions remain in Journal. */
export function WatchlistTabs() {
  const [tab, setTab] = useState<Tab>("strategies");

  useEffect(() => {
    // One-time sync of the initial tab from the URL (an external system).
    const requested = new URLSearchParams(window.location.search).get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isTab(requested)) setTab(requested);
  }, []);

  function selectTab(nextTab: Tab) {
    setTab(nextTab);

    // Keep the selected mode in the address bar without a route transition.
    // A reload (or a copied link) will therefore reopen the same Watchlist.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    window.history.replaceState(window.history.state, "", url);
  }

  return (
    <div className="watchlist-tabs space-y-6">
      {VISIBLE_TABS.length > 1 ? <div role="tablist" aria-label="Watchlist mode" className="binary-seg flex gap-1.5">
        {VISIBLE_TABS.map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => selectTab(value)}
            className={`check-chip pressable ${tab === value ? "check-chip-active" : ""}`}
          >
            {TAB_LABEL[value]}
          </button>
        ))}
      </div> : null}
      {watchlistPanel(tab)}
    </div>
  );
}
