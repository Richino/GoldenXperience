"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";

export interface OpenPositionFill {
  brokerTradeId: string;
  price: number;
  units: number;
  stopPrice: number | null;
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
          id: string;
          entryPrice: number;
          stopPrice?: number | null;
          units: number;
          currentPrice: number;
          unrealizedPL: number;
        }>;
      };
      const nextFills: Record<string, OpenPositionFill> = {};
      for (const position of payload.data ?? []) {
        const fill = {
          brokerTradeId: position.id,
          price: position.entryPrice,
          units: Math.abs(position.units),
          stopPrice: position.stopPrice ?? null,
          currentPrice: position.currentPrice,
          unrealizedPL: position.unrealizedPL,
        };
        // Exact broker IDs are the authoritative lookup. Keep the instrument
        // alias for older presentation-only callers that do not carry an ID.
        nextFills[`broker:${position.id}`] = fill;
        nextFills[position.instrument] ??= fill;
      }
      setFills(nextFills);
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

  useForegroundRefresh(load);

  return fills;
}
