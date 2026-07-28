"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import type { EconomicCalendarSnapshot } from "@/lib/oanda/calendar";
import {
  buildCalendarSnapshot,
  createMockCalendarEvents,
} from "@/lib/oanda/calendar";

const FALLBACK_SNAPSHOT = buildCalendarSnapshot({
  events: createMockCalendarEvents(),
  source: "mock",
  connected: false,
});

export function useEconomicCalendar() {
  const [snapshot, setSnapshot] =
    useState<EconomicCalendarSnapshot>(FALLBACK_SNAPSHOT);
  const [loading, setLoading] = useState(true);

  const loadCalendar = useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch(apiUrl("/api/oanda/calendar"), {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        data: EconomicCalendarSnapshot;
      };

      if (payload.data) {
        setSnapshot(payload.data);
      }
    } catch {
      setSnapshot(FALLBACK_SNAPSHOT);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);

  return { snapshot, loading, reload: loadCalendar };
}
