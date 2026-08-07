"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";

export interface OpenPositionFill {
  price: number;
  units: number;
}

/**
 * The broker's live positions, keyed by instrument.
 *
 * Only the fill price and size are kept. Those barely change once a position is
 * open, so a slow poll is enough — the value is then marked against streamed
 * quotes on every tick, which reproduces the broker's own unrealised figure
 * without asking it for a number several times a second.
 *
 * Empty when practice execution is off, and callers fall back to the paper
 * model in that case.
 */
export function useOpenPositionFills() {
  const [fills, setFills] = useState<Record<string, OpenPositionFill>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/oanda/open-positions"), {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json() as {
        data?: Array<{ instrument: string; entryPrice: number; units: number }>;
      };
      setFills(
        Object.fromEntries(
          (payload.data ?? []).map((position) => [
            position.instrument,
            { price: position.entryPrice, units: Math.abs(position.units) },
          ]),
        ),
      );
    } catch {
      // A missing broker snapshot leaves the paper model in place.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return fills;
}
