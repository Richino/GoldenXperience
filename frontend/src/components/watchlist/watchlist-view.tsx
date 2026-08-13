"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { formatClockTime } from "@/lib/format/datetime";
import { getPaperTradingAvailability, type PaperTradingAvailability } from "@/lib/strategy/strategy-engine";
import { watchlistCardStatus, type WatchlistCardStatus } from "@/lib/watchlist-status";

type WatchRow = {
  instrument: string;
  evaluatedAt: string | null;
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  direction: "long" | "short" | null;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  session: string;
  conditions: Array<{ name: string; passed: boolean; required: boolean; reason: string }>;
  openTradeId: string | null;
  batchNumber: number | null;
  tradeSequence: string | null;
};

/** When every monitored pair reports the same status, lift it to the section. */
function sharedStatusLabel(rows: WatchRow[]) {
  if (rows.length < 2) return null;
  const labels = rows.map((row) => watchlistCardStatus(row).label);
  if (labels.some((label) => !label)) return null;
  const first = labels[0];
  return labels.every((label) => label === first) ? first : null;
}

function price(value: number | null, instrument: string) {
  return value === null ? "—" : formatChartPrice(value, instrument);
}

function evaluatedLabel(value: string | null) {
  if (!value) return "Waiting";
  return formatClockTime(value);
}

// Keep the Watchlist reading the same readiness language as Dashboard: blue at
// early checklist progress, cyan through confirmation, then clear green.
function checklistProgressColor(progress: number) {
  const clamped = Math.max(0, Math.min(100, progress));
  const hue = Math.round(
    clamped <= 50
      ? 220 - clamped * 0.5
      : clamped <= 75
        ? 195 - (clamped - 50) * 2
        : 145 - (clamped - 75) * 0.8,
  );
  return `hsl(${hue} 90% ${Math.round(55 - clamped * 0.04)}%)`;
}

function hasTradeLevels(row: WatchRow) {
  return (
    Boolean(row.direction) &&
    row.entry !== null &&
    row.stop !== null &&
    row.target !== null
  );
}

function levelsContent(row: WatchRow, availability: PaperTradingAvailability) {
  const { entry, stop, target } = row;
  if (hasTradeLevels(row) && entry !== null && stop !== null && target !== null) {
    return (
      <dl className="wl-levels-grid">
        <div className="wl-level">
          <dt>Entry</dt>
          <dd className="metric-number">{price(entry, row.instrument)}</dd>
        </div>
        <div className="wl-level">
          <dt>Target</dt>
          <dd className="metric-number is-target">
            {price(target, row.instrument)}
          </dd>
        </div>
        <div className="wl-level">
          <dt>Stop</dt>
          <dd className="metric-number is-stop">
            {price(stop, row.instrument)}
          </dd>
        </div>
      </dl>
    );
  }
  // The window message is in the header / section note; repeating the long
  // availability.detail under every pair said nothing about this pair.
  if (!row.openTradeId && availability.state !== "entry_window_open") return null;
  const failed = row.conditions.filter((item) => item.required && !item.passed).map((item) => item.name).slice(0, 2);
  return failed.length ? `No setup: ${failed.join(", ")}` : "No valid trade levels";
}

export function WatchlistView() {
  const [snapshot, setSnapshot] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const quotes = useLiveQuotes();
  /**
   * Prices come off the stream, everything else off the snapshot below.
   *
   * The poll carries the strategy's verdict — conditions, levels, session —
   * which only changes when a candle closes, so a minute is the right cadence
   * for it. Quotes move constantly and were sitting up to a minute stale
   * beside it. A pair the stream has not reported keeps its polled price.
   */
  const rows = useMemo(
    () =>
      snapshot.map((row) => {
        const quote = quotes[row.instrument];
        if (!quote) return row;
        return {
          ...row,
          bid: quote.bid,
          ask: quote.ask,
          spreadPips: (quote.ask - quote.bid) / pipSizeFor(row.instrument),
        };
      }),
    [snapshot, quotes],
  );
  const availability = getPaperTradingAvailability();
  const sharedStatus = sharedStatusLabel(rows);
  const layout = "detail";

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" });
      const payload = await response.json() as { watchlist?: WatchRow[]; error?: string };
      if (!response.ok || !payload.watchlist) throw new Error(payload.error ?? "Watchlist is unavailable.");
      setSnapshot(payload.watchlist);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Watchlist is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div className="watchlist-view watchlist-minimal space-y-8 lg:space-y-10">
      <header className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display">Watchlist</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            {availability.state === "entry_window_open"
              ? "Ten-pair paper monitor"
              : availability.detail}
          </p>
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

      <section className="dashboard-minimal-section" aria-label="Monitored pairs">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Pairs</h2>
          <p className="metric-number text-xs text-[color:var(--muted)]">{rows.length || "—"}</p>
        </div>

        {sharedStatus ? (
          <p className="wl-section-note mt-2 text-xs leading-snug text-[color:var(--muted)]">
            {sharedStatus}
          </p>
        ) : null}

        {rows.length ? (
          <div className="wl-pairs mt-3" data-wl-layout={layout}>
            {rows.map((row) => {
              const status: WatchlistCardStatus = watchlistCardStatus(row);
              const rowStatus = status.label;
              const levels = levelsContent(row, availability);
              const direction = row.direction;
              const hasDetail = Boolean(rowStatus || levels);
              const progress = status.progress;
              const showProgress = status.state !== "open" && status.state !== "unavailable";
              const progressColor = checklistProgressColor(progress);
              return (
                <Link
                  key={row.instrument}
                  href={`/signals?instrument=${encodeURIComponent(row.instrument)}`}
                  className="wl-pair-card pressable"
                  data-state={status.state}
                  style={
                    showProgress
                      ? { "--watch-progress-color": progressColor } as CSSProperties
                      : undefined
                  }
                >
                  {/* Two stacked blocks on mobile. On desktop the wrappers go
                      `display: contents` so these cells become grid items. */}
                  <div className="wl-main min-w-0">
                    <p className="wl-pair">
                      <span className="wl-pair-name">
                        {displayNameFor(row.instrument)}
                      </span>
                      {direction ? (
                        <span
                          className={
                            direction === "long"
                              ? "wl-dir is-long"
                              : "wl-dir is-short"
                          }
                        >
                          {direction}
                        </span>
                      ) : null}
                    </p>
                    {hasDetail ? (
                      <div className="wl-detail">
                        {rowStatus ? (
                          <p
                            className={`wl-status watchlist-status-label ${status.tone}`}
                            style={showProgress ? { color: progressColor } : undefined}
                          >
                            {rowStatus}
                          </p>
                        ) : null}
                        {levels ? (
                          <div
                            className={`wl-levels ${rowStatus ? "has-status" : ""}`}
                          >
                            {levels}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="wl-aside">
                    <p className="wl-quote metric-number">
                      {price(row.bid, row.instrument)}
                      <span className="wl-quote-sep"> / </span>
                      {price(row.ask, row.instrument)}
                    </p>
                    <p className="wl-meta metric-number">
                      {row.spreadPips === null
                        ? "—"
                        : `${row.spreadPips.toFixed(1)} pips`}
                      {" · "}
                      {evaluatedLabel(row.evaluatedAt)}
                    </p>
                  </div>
                  {showProgress ? (
                    <div
                      className="wl-checklist-progress"
                      role="progressbar"
                      aria-label={`${displayNameFor(row.instrument)} checklist completion`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <span
                        style={{
                          width: `${progress}%`,
                          backgroundColor: progressColor,
                          boxShadow: `0 0 0.4rem ${progressColor}`,
                        }}
                      />
                    </div>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ) : loading ? (
          <p className="mt-4 text-sm text-[color:var(--muted)]">Loading pairs…</p>
        ) : (
          <p className="mt-4 text-sm text-[color:var(--muted)]">No monitored pairs.</p>
        )}
      </section>
    </div>
  );
}
