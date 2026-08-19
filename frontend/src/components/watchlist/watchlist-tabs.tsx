"use client";

import { useEffect, useState } from "react";
import { WatchlistView } from "@/components/watchlist/watchlist-view";
import { BinaryWatchlistView } from "@/components/watchlist/binary-watchlist-view";
import { MultiStrategyView } from "@/components/watchlist/multistrategy-view";

type Tab = "trading" | "strategies" | "binary";

const TAB_LABEL: Record<Tab, string> = { trading: "Trading", strategies: "Strategies", binary: "Binary" };

/**
 * The Watchlist page shell: a Trading | Strategies | Binary switch. Trading
 * preserves the existing forex watchlist unchanged; Strategies shows the four
 * multi-strategy candidates per pair and the adaptive engine's pick; Binary
 * shows the prediction engine's monitored symbols. The initial tab honours a
 * `?tab=strategies` / `?tab=binary` deep link.
 */
export function WatchlistTabs() {
  const [tab, setTab] = useState<Tab>("trading");

  useEffect(() => {
    // One-time sync of the initial tab from the URL (an external system).
    const requested = new URLSearchParams(window.location.search).get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requested === "binary" || requested === "strategies") setTab(requested);
  }, []);

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Watchlist mode" className="binary-seg flex gap-1.5">
        {(["trading", "strategies", "binary"] as const).map((value) => (
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
      {tab === "trading" ? <WatchlistView /> : tab === "strategies" ? <MultiStrategyView /> : <BinaryWatchlistView />}
    </div>
  );
}
