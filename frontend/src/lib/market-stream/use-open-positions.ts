"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";

export interface OpenPositionFill {
  price: number;
  units: number;
  /** Mid from the broker's last pricing read — used when the tick stream has not
   *  delivered this pair yet, so a row can still mark to market. */
  currentPrice: number;
  /** Account-currency unrealised P&L from the broker. Prefer this over
   *  recomputing `move × units` so JPY/CAD pairs never show quote cash as USD. */
  unrealizedPL: number;
}

/**
 * The broker's live positions, keyed by instrument.
 *
 * Fill price and size barely change once a position is open, so a slow poll is
 * enough — streamed quotes then mark the value on every tick. `currentPrice`
 * and `unrealizedPL` ride along as a fallback when the stream is quiet for a
 * pair, so a journal row does not sit on "Open" with no figure.
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
      const payload = (await response.json()) as {
        data?: Array<{
          instrument: string;
          entryPrice: number;
          units: number;
          currentPrice: number;
          unrealizedPL: number;
        }>;
      };
      setFills(
        Object.fromEntries(
          (payload.data ?? []).map((position) => [
            position.instrument,
            {
              price: position.entryPrice,
              units: Math.abs(position.units),
              currentPrice: position.currentPrice,
              unrealizedPL: position.unrealizedPL,
            },
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
