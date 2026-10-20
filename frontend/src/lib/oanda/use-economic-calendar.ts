"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import type { EconomicCalendarSnapshot } from "@/lib/oanda/calendar";
import { createEconomicCalendarCache } from "@/lib/oanda/economic-calendar-cache";
import {
  buildCalendarSnapshot,
  createMockCalendarEvents,
} from "@/lib/oanda/calendar";

const FALLBACK_SNAPSHOT = buildCalendarSnapshot({
  events: createMockCalendarEvents(),
  source: "mock",
  connected: false,
});

// All Home, chart, warning and trade-ticket consumers share this one cache.
// Browser storage is accessed only from load(), after mount, to preserve SSR.
const calendarCache = createEconomicCalendarCache(async () => {
  const response = await fetch(apiUrl("/api/oanda/calendar"), {
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The news calendar could not be loaded.");
  const payload = await response.json() as { data: EconomicCalendarSnapshot };
  return payload.data;
}, { storage: () => window.sessionStorage });

export function useEconomicCalendar() {
  const [snapshot, setSnapshot] =
    useState<EconomicCalendarSnapshot>(FALLBACK_SNAPSHOT);
  const [loading, setLoading] = useState(true);

  const loadCalendar = useCallback((force = false) => calendarCache.load(force)
    .then(setSnapshot, () => setSnapshot(FALLBACK_SNAPSHOT))
    .finally(() => setLoading(false)), []);

  useEffect(() => {
    void loadCalendar();
    // Check locally once a minute; only an expired cache starts a network read.
    const timer = window.setInterval(() => void loadCalendar(), 60_000);
    const refreshVisible = () => { if (document.visibilityState === "visible") void loadCalendar(); };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [loadCalendar]);

  const reload = useCallback(() => loadCalendar(true), [loadCalendar]);
  return { snapshot, loading, reload };
}
