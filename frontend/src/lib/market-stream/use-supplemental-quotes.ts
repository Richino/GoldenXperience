"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf } from "@/lib/instruments/catalog";
import type { LiveQuote } from "@/lib/market-stream/use-live-quotes";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";

function conversionMajorsFor(instrument: string): string[] {
  const { quote } = currenciesOf(instrument);
  if (!quote || quote === "USD") return [];
  return [`${quote}_USD`, `USD_${quote}`];
}

/**
 * REST bid/ask for instruments the tick stream has not delivered yet.
 *
 * The journal marks open rows from the stream; when a pair is quiet (or the
 * socket connected after its last tick was dropped), those rows would sit on
 * "Open". Polling pricing for only the missing codes fills the gap without
 * replacing live ticks once they arrive. Conversion majors (USD_JPY for an
 * AUD_JPY row, …) are pulled too so fill money can convert into USD.
 */
export function useSupplementalQuotes(
  instruments: string[],
  liveQuotes: Record<string, LiveQuote | undefined>,
) {
  const [restQuotes, setRestQuotes] = useState<Record<string, LiveQuote>>({});

  const wanted = useMemo(() => {
    const set = new Set<string>();
    for (const instrument of instruments) {
      set.add(instrument);
      for (const major of conversionMajorsFor(instrument)) set.add(major);
    }
    return [...set].sort();
  }, [instruments]);

  // Only codes still absent from the stream — once a tick lands, REST stops
  // owning that pair. Re-poll while the gap remains so marks stay fresh.
  const missingKey = useMemo(() => {
    return wanted
      .filter((instrument) => {
        const live = liveQuotes[instrument];
        return !(live && Number.isFinite(live.bid) && Number.isFinite(live.ask));
      })
      .join(",");
  }, [wanted, liveQuotes]);

  const load = useCallback(async () => {
    if (!missingKey) return;
    const instruments = missingKey.split(",");
    try {
      const response = await fetch(
        apiUrl(`/api/oanda/pricing?instruments=${instruments.join(",")}`),
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as {
        data?: Array<{ instrument: string; bid: number; ask: number }>;
      };
      const next: Record<string, LiveQuote> = {};
      for (const row of payload.data ?? []) {
        if (Number.isFinite(row.bid) && Number.isFinite(row.ask)) {
          next[row.instrument] = { bid: row.bid, ask: row.ask };
        }
      }
      if (Object.keys(next).length) {
        setRestQuotes((current) => ({ ...current, ...next }));
      }
    } catch {
      // Stream or broker mid may still cover the row.
    }
  }, [missingKey]);

  useEffect(() => {
    if (!missingKey) return;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load, missingKey]);

  useForegroundRefresh(load, Boolean(missingKey));

  return useMemo(() => {
    const merged: Record<string, LiveQuote | undefined> = { ...restQuotes };
    for (const [instrument, quote] of Object.entries(liveQuotes)) {
      if (quote) merged[instrument] = quote;
    }
    return merged;
  }, [liveQuotes, restQuotes]);
}
