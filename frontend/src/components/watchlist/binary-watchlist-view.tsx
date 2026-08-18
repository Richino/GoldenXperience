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
      ? `${formatClockTime(row.activeStartAt)} → ${formatClockTime(row.activeExpiration)}`
      : "prediction open";
    return window;
  }
  if (row.dataStatus !== "connected") return "Waiting for market data";
  if (!row.bias || row.bias === "wait") return "No signal — waiting for an edge";
  return row.bias === "up" ? "Model bias favours UP" : "Model bias favours DOWN";
}

/**
 * The model's raw score runs 0.5 (no edge) → ~0.95 (max conviction); anything
 * below the engine threshold reads as WAIT. Rescale to a 0–1 conviction so the
 * meter fills proportionally to how far past a coin-flip the read sits.
 */
function conviction(score: number | null) {
  if (score === null) return 0;
  return Math.max(0, Math.min(1, (score - 0.5) / 0.45));
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
          <div className="binary-wl-list">
            {merged.map((row) => {
              const isOpen = Boolean(row.activePredictionId);
              const direction = row.activeDirection ?? (row.bias && row.bias !== "wait" ? row.bias : null);
              const bias = direction ?? "wait";
              const fill = conviction(row.score);
              return (
                <Link
                  key={row.instrument}
                  href={isOpen ? `/journal?tab=binary&prediction=${row.activePredictionId}` : "/watchlist?tab=binary"}
                  className="binary-wl-card pressable"
                  data-bias={bias}
                  data-state={isOpen ? "open" : undefined}
                >
                  <div className="binary-wl-top">
                    <span className="binary-wl-id">
                      <span className="binary-wl-name">{displayNameFor(row.instrument)}</span>
                      {isOpen ? <span className="binary-wl-live">Live</span> : null}
                      <span
                        className={
                          bias === "up"
                            ? "binary-wl-pill is-up"
                            : bias === "down"
                              ? "binary-wl-pill is-down"
                              : "binary-wl-pill is-wait"
                        }
                      >
                        {bias === "up" ? "UP" : bias === "down" ? "DOWN" : "WAIT"}
                      </span>
                    </span>
                    <span className="binary-wl-quote">
                      <span className="binary-wl-quote-val metric-number">
                        {price(row.bid, row.instrument)}
                        <span className="binary-wl-quote-sep"> / </span>
                        {price(row.ask, row.instrument)}
                      </span>
                      <span className="binary-wl-quote-label">bid / ask</span>
                    </span>
                  </div>

                  <div
                    className="binary-wl-meter"
                    role="progressbar"
                    aria-label={`${displayNameFor(row.instrument)} model conviction`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(fill * 100)}
                  >
                    <span style={{ width: `${Math.round(fill * 100)}%` }} />
                  </div>

                  <div className="binary-wl-foot">
                    <span className="binary-wl-status">{statusLine(row)}</span>
                    <span className="binary-wl-metrics metric-number">
                      {row.score === null ? "—" : `score ${row.score.toFixed(2)}`}
                      {" · "}
                      {row.evaluatedAt ? formatClockTime(row.evaluatedAt) : "waiting"}
                    </span>
                  </div>
                </Link>
              );
            })}
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
