"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatChartPrice } from "@/lib/chart-utils";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { scorePercent } from "@/lib/binary-format";
import type { BinaryWatchRow } from "@/types/binary";

function biasLabel(row: BinaryWatchRow) {
  if (row.activePredictionId && row.activeDirection) return row.activeDirection === "up" ? "Active · UP" : "Active · DOWN";
  if (row.dataStatus !== "connected") return "Waiting for data";
  if (!row.bias || row.bias === "wait") return "No signal";
  return row.bias === "up" ? "Bias UP" : "Bias DOWN";
}

/**
 * The Binary Watchlist on the dashboard: the model's current per-symbol bias and
 * score, shown under the forex Watchlist and kept separate from it.
 */
export function BinaryWatchlistCard() {
  const [rows, setRows] = useState<BinaryWatchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const quotes = useLiveQuotes();

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/binary/watchlist"), { credentials: "include", cache: "no-store" });
      const payload = (await response.json()) as { watchlist?: BinaryWatchRow[]; error?: string };
      if (!response.ok || !payload.watchlist) throw new Error(payload.error ?? "Binary watchlist is unavailable.");
      setRows(payload.watchlist);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Binary watchlist is unavailable.");
    }
  }, []);

  useEffect(() => {
    // load resolves its fetch before setting state, so the update lands in a
    // promise continuation rather than synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useForegroundRefresh(load);

  return (
    <section className="dashboard-minimal-section" aria-label="Binary watchlist">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Binary watchlist</h2>
        <Link href="/watchlist?tab=binary" className="link-quiet pressable text-xs">
          View all
        </Link>
      </div>
      {error ? <p className="mt-3 text-xs text-[color:var(--danger)]">{error}</p> : null}
      <div className="dashboard-watchlist-grid mt-3">
        {rows.map((row) => {
          const score = scorePercent(row.score);
          const shownBid = quotes[row.instrument]?.bid ?? row.bid;
          const active = Boolean(row.activePredictionId);
          return (
            <div key={row.instrument} className="dashboard-minimal-row block py-3" data-state={active ? "open" : undefined}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayNameFor(row.instrument)}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--muted)]">{biasLabel(row)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="metric-number text-sm text-[color:var(--muted)]">
                    {shownBid === null ? "—" : formatChartPrice(shownBid, row.instrument)}
                  </p>
                  {score !== null && !active ? (
                    <p className="metric-number mt-0.5 text-xs font-medium text-[color:var(--muted-strong)]">score {row.score!.toFixed(2)}</p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
