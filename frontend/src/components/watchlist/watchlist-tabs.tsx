"use client";

import { useEffect, useState } from "react";
import { WatchlistView } from "@/components/watchlist/watchlist-view";
import { BinaryWatchlistView } from "@/components/watchlist/binary-watchlist-view";

type Tab = "trading" | "binary";

/**
 * The Watchlist page shell: a Trading | Binary switch. Trading preserves the
 * existing forex watchlist unchanged; Binary shows the prediction engine's
 * monitored symbols. The initial tab honours a `?tab=binary` deep link.
 */
export function WatchlistTabs() {
  const [tab, setTab] = useState<Tab>("trading");

  useEffect(() => {
    // One-time sync of the initial tab from the URL (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (new URLSearchParams(window.location.search).get("tab") === "binary") setTab("binary");
  }, []);

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Watchlist mode" className="binary-seg flex gap-1.5">
        {(["trading", "binary"] as const).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`check-chip pressable ${tab === value ? "check-chip-active" : ""}`}
          >
            {value === "trading" ? "Trading" : "Binary"}
          </button>
        ))}
      </div>
      {tab === "trading" ? <WatchlistView /> : <BinaryWatchlistView />}
    </div>
  );
}
