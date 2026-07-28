"use client";

import { useEffect, useState } from "react";
import {
  PAPER_JOURNAL_STORAGE_KEY,
  PAPER_JOURNAL_UPDATED_EVENT,
  parseStoredJournal,
} from "@/lib/journal/storage";
import type { JournalTrade } from "@/types/forex";

const EMPTY_JOURNAL_TRADES: JournalTrade[] = [];

export function useJournalTrades(seedTrades: JournalTrade[] = EMPTY_JOURNAL_TRADES) {
  const [trades, setTrades] = useState(seedTrades);

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      const stored = parseStoredJournal(
        window.localStorage.getItem(PAPER_JOURNAL_STORAGE_KEY),
      );
      if (!cancelled) {
        setTrades(stored ?? seedTrades);
      }
    }

    window.queueMicrotask(refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(PAPER_JOURNAL_UPDATED_EVENT, refresh);

    return () => {
      cancelled = true;
      window.removeEventListener("storage", refresh);
      window.removeEventListener(PAPER_JOURNAL_UPDATED_EVENT, refresh);
    };
  }, [seedTrades]);

  return trades;
}
