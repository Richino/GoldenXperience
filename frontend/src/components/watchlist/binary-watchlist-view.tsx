"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime } from "@/lib/format/datetime";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import type { BinaryWatchRow } from "@/types/binary";

function price(value: number | null, instrument: string) {
  return value === null ? "—" : formatChartPrice(value, instrument);
}

function statusLine(row: BinaryWatchRow) {
  if (row.activePredictionId && row.activeDirection) {
    const window = row.activeStartAt && row.activeExpiration
      ? ` · ${formatClockTime(row.activeStartAt)} → ${formatClockTime(row.activeExpiration)}`
      : "";
    return `Active prediction · ${row.activeDirection === "up" ? "UP" : "DOWN"}${window}`;
  }
  if (row.dataStatus !== "connected") return "Waiting for market data";
  if (!row.bias || row.bias === "wait") return "No signal — waiting for an edge";
  return row.bias === "up" ? "Model bias: UP" : "Model bias: DOWN";
}

/**
 * The Binary tab of the Watchlist page: the symbols the Binary Prediction engine
 * monitors, with the model's live bias, score, quote and any active prediction.
 * Separate from the forex Trading watchlist.
 */
export function BinaryWatchlistView() {
  const [rows, setRows] = useState<BinaryWatchRow[]>([]);
  const [loading, setLoading] = useState(true);
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
    } finally {
      setLoading(false);
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

  const merged = useMemo(
    () =>
      rows.map((row) => {
        const quote = quotes[row.instrument];
        if (!quote) return row;
        return { ...row, bid: quote.bid, ask: quote.ask, spreadPips: (quote.ask - quote.bid) / pipSizeFor(row.instrument) };
      }),
    [rows, quotes],
  );

  return (
    <div className="watchlist-view space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Binary monitor</h2>
          <p className="mt-1 text-xs text-[color:var(--muted)]">10-minute directional model · {merged[0]?.modelName ?? "binary-baseline-v1"}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="mobile-icon-btn pressable text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)]"
          aria-label="Refresh"
        >
          <RefreshCw className={`size-[18px] ${loading ? "animate-spin" : ""}`} strokeWidth={1.9} />
        </button>
      </header>

      {error ? <p className="research-error">{error}</p> : null}

      <section className="dashboard-minimal-section" aria-label="Binary pairs">
        {merged.length ? (
          <div className="wl-pairs mt-1" data-wl-layout="detail">
            {merged.map((row) => (
              <Link
                key={row.instrument}
                href={row.activePredictionId ? `/journal?tab=binary&prediction=${row.activePredictionId}` : "/watchlist?tab=binary"}
                className="wl-pair-card pressable"
                data-state={row.activePredictionId ? "open" : undefined}
              >
                <div className="wl-main min-w-0">
                  <p className="wl-pair">
                    <span className="wl-pair-name">{displayNameFor(row.instrument)}</span>
                    {row.bias && row.bias !== "wait" ? (
                      <span className={row.bias === "up" ? "binary-dir is-up" : "binary-dir is-down"}>
                        {row.bias === "up" ? "UP" : "DOWN"}
                      </span>
                    ) : null}
                  </p>
                  <div className="wl-detail">
                    <p className="wl-status">{statusLine(row)}</p>
                  </div>
                </div>
                <div className="wl-aside">
                  <p className="wl-quote metric-number">
                    {price(row.bid, row.instrument)}
                    <span className="wl-quote-sep"> / </span>
                    {price(row.ask, row.instrument)}
                  </p>
                  <p className="wl-meta metric-number">
                    {row.score === null ? "—" : `score ${row.score.toFixed(2)}`}
                    {" · "}
                    {row.evaluatedAt ? formatClockTime(row.evaluatedAt) : "waiting"}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        ) : loading ? (
          <p className="mt-4 text-sm text-[color:var(--muted)]">Loading…</p>
        ) : (
          <p className="mt-4 text-sm text-[color:var(--muted)]">No monitored pairs.</p>
        )}
        <p className="mt-4 text-[0.6875rem] leading-snug text-[color:var(--muted)]">
          Score is a bounded model heuristic, not a calibrated probability. A bias is not a prediction until the engine opens one.
        </p>
      </section>
    </div>
  );
}
