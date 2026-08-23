"use client";

import { useEffect, useState } from "react";
import { JournalView } from "@/components/journal/journal-view";
import { BinaryJournalView } from "@/components/journal/binary-journal-view";

type Tab = "trades" | "binary";

/**
 * The Journal page shell: a Trades | Binary Predictions switch. Trades preserves
 * the existing trade journal unchanged; Binary Predictions shows the full,
 * immutable prediction history. Honours a `?tab=binary` deep link.
 */
export function JournalTabs() {
  const [tab, setTab] = useState<Tab>("trades");

  useEffect(() => {
    // One-time sync of the initial tab from the URL (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (new URLSearchParams(window.location.search).get("tab") === "binary") setTab("binary");
  }, []);

  function selectTab(nextTab: Tab) {
    setTab(nextTab);

    // Keep the selected journal in the URL without reloading its data. A page
    // refresh (or copied link) will then restore the same view.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    window.history.replaceState(window.history.state, "", url);
  }

  return (
    <div className="journal-view journal-minimal space-y-6">
      <header>
        <h1 className="text-display">Journal</h1>
        <div role="tablist" aria-label="Journal mode" className="binary-seg mt-3 flex gap-1.5">
          {(["trades", "binary"] as const).map((value) => (
            <button
              key={value}
              role="tab"
              type="button"
              aria-selected={tab === value}
              onClick={() => selectTab(value)}
              className={`check-chip pressable ${tab === value ? "check-chip-active" : ""}`}
            >
              {value === "trades" ? "Trades" : "Binary Predictions"}
            </button>
          ))}
        </div>
      </header>
      {tab === "trades" ? <JournalView embedded /> : <BinaryJournalView />}
    </div>
  );
}
