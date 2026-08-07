"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
import { formatClockTime } from "@/lib/format/datetime";
import { getPaperTradingAvailability, type PaperTradingAvailability } from "@/lib/strategy/strategy-engine";

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

function statusFor(row: WatchRow, availability: PaperTradingAvailability) {
  if (row.openTradeId) return { label: "Open paper trade", tone: "text-[color:var(--accent)]" };
  if (availability.state === "market_closed") return { label: "Market closed", tone: "text-[color:var(--muted)]" };
  if (availability.state === "waiting_for_entry_window") return { label: "Waiting", tone: "text-[color:var(--muted)]" };
  if (row.dataStatus !== "connected") return { label: "Data unavailable", tone: "text-[color:var(--danger)]" };
  if (row.setupStatus === "valid") return { label: "Entry ready", tone: "text-[color:var(--success)]" };
  if (row.setupStatus === "developing") return { label: "Developing", tone: "text-[color:var(--foreground)]" };
  return { label: "No setup", tone: "text-[color:var(--muted)]" };
}

function price(value: number | null, instrument: string) {
  return value === null ? "—" : formatChartPrice(value, instrument);
}

function evaluatedLabel(value: string | null) {
  if (!value) return "Waiting";
  return formatClockTime(value);
}

function Levels({ row, availability }: { row: WatchRow; availability: PaperTradingAvailability }) {
  const visible = row.openTradeId || row.setupStatus === "valid";
  if (!visible || row.entry === null || row.stop === null || row.target === null) {
    if (!row.openTradeId && availability.state !== "entry_window_open") {
      return <span className="text-xs text-[color:var(--muted)]">{availability.detail}</span>;
    }
    const failed = row.conditions.filter((item) => item.required && !item.passed).map((item) => item.name).slice(0, 2);
    return <span className="text-xs text-[color:var(--muted)]">{failed.length ? `No setup: ${failed.join(", ")}` : "No valid trade levels"}</span>;
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <span>
        <span className="text-[color:var(--muted)]">Entry </span>
        <b className="metric-number font-medium">{price(row.entry, row.instrument)}</b>
      </span>
      <span>
        <span className="text-[color:var(--muted)]">Target </span>
        <b className="metric-number font-medium text-[color:var(--success)]">{price(row.target, row.instrument)}</b>
      </span>
      <span>
        <span className="text-[color:var(--muted)]">Stop </span>
        <b className="metric-number font-medium text-[color:var(--danger)]">{price(row.stop, row.instrument)}</b>
      </span>
    </div>
  );
}

export function WatchlistView() {
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const availability = getPaperTradingAvailability();

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" });
      const payload = await response.json() as { watchlist?: WatchRow[]; error?: string };
      if (!response.ok || !payload.watchlist) throw new Error(payload.error ?? "Watchlist is unavailable.");
      setRows(payload.watchlist);
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
        <div>
          <h1 className="text-display">Watchlist</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">Ten-pair paper monitor</p>
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

        {rows.length ? (
          <div className="mt-3">
            {rows.map((row) => {
              const status = statusFor(row, availability);
              const direction = row.direction;
              return (
                <Link
                  key={row.instrument}
                  href={`/signals?instrument=${encodeURIComponent(row.instrument)}`}
                  className="dashboard-minimal-row pressable flex items-start justify-between gap-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {displayNameFor(row.instrument)}{" "}
                      {direction ? (
                        <span className={direction === "long" ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>
                          {direction}
                        </span>
                      ) : (
                        <span className="text-[color:var(--muted)]">{row.session}</span>
                      )}
                    </p>
                    <p className={`watchlist-status-label mt-0.5 text-xs ${status.tone}`}>
                      {status.label}
                      {row.batchNumber
                        ? ` · Batch ${row.batchNumber}${row.tradeSequence ? ` · #${row.tradeSequence}` : ""}`
                        : ""}
                    </p>
                    <div className="mt-1.5">
                      <Levels row={row} availability={availability} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="metric-number text-sm">
                      {price(row.bid, row.instrument)} / {price(row.ask, row.instrument)}
                    </p>
                    <p className="metric-number mt-0.5 text-[0.68rem] text-[color:var(--muted)]">
                      {row.spreadPips === null ? "—" : `${row.spreadPips.toFixed(1)} pips`}
                      {" · "}
                      {evaluatedLabel(row.evaluatedAt)}
                    </p>
                  </div>
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
