"use client";

import { useEffect, useState } from "react";
import {
  EMPTY_PAPER_JOURNAL_DAY,
  PAPER_JOURNAL_STORAGE_KEY,
  PAPER_JOURNAL_UPDATED_EVENT,
  parseStoredJournal,
  summarizePaperJournalDay,
} from "@/lib/journal/storage";

export function usePaperJournalDay() {
  const [summary, setSummary] = useState(EMPTY_PAPER_JOURNAL_DAY);

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      const records = parseStoredJournal(
        window.localStorage.getItem(PAPER_JOURNAL_STORAGE_KEY),
      );
      if (!cancelled) {
        setSummary(
          records
            ? summarizePaperJournalDay(records)
            : EMPTY_PAPER_JOURNAL_DAY,
        );
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
  }, []);

  return summary;
}
