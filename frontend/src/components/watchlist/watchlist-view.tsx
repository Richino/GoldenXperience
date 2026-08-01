"use client";

import Link from "next/link";
import { ArrowUpRight, Clock3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
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
  if (row.openTradeId) return { label: "Open paper trade", className: "status-pill status-pill-accent" };
  if (availability.state === "market_closed") return { label: "Market closed", className: "status-pill status-pill-neutral" };
  if (availability.state === "waiting_for_entry_window") return { label: "Waiting for entry window", className: "status-pill status-pill-neutral" };
  if (row.dataStatus !== "connected") return { label: "Data unavailable", className: "status-pill status-pill-danger" };
  if (row.setupStatus === "valid") return { label: "Entry ready", className: "status-pill status-pill-success" };
  if (row.setupStatus === "developing") return { label: "Developing", className: "status-pill status-pill-neutral" };
  return { label: "No setup", className: "status-pill status-pill-neutral" };
}

function price(value: number | null, instrument: string) {
  return value === null ? "—" : formatChartPrice(value, instrument);
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
    <div className="grid grid-cols-3 gap-3 text-xs">
      <span><span className="text-[color:var(--muted)]">Entry </span><b className="metric-number">{price(row.entry, row.instrument)}</b></span>
      <span><span className="text-[color:var(--muted)]">Target </span><b className="metric-number text-[color:var(--success)]">{price(row.target, row.instrument)}</b></span>
      <span><span className="text-[color:var(--muted)]">Stop </span><b className="metric-number text-[color:var(--danger)]">{price(row.stop, row.instrument)}</b></span>
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
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--accent)]">Automatic paper monitor</p>
          <h1 className="text-page-title mt-1">Watchlist</h1>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--muted)]">The fixed ten-pair universe for the current 100-trade cycle. Levels appear only for a valid setup or an open paper trade.</p>
        </div>
        <button type="button" onClick={() => void load()} className="secondary-button pressable inline-flex items-center gap-2" disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      {error ? <p className="research-error">{error}</p> : null}

      <section className="app-card overflow-hidden">
        <div className="hidden grid-cols-[1.15fr_0.8fr_0.8fr_1.8fr_1fr_24px] gap-4 border-b border-[color:var(--border)] px-5 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted)] md:grid">
          <span>Pair</span><span>Quote</span><span>Status</span><span>Trade plan</span><span>Evaluated</span><span />
        </div>
        <div className="divide-y divide-[color:var(--border)]">
          {rows.map((row) => {
            const status = statusFor(row, availability);
            return (
              <Link key={row.instrument} href={`/signals?instrument=${encodeURIComponent(row.instrument)}`} className="pressable grid gap-4 px-4 py-4 hover:bg-[color:var(--surface-raised)] md:grid-cols-[1.15fr_0.8fr_0.8fr_1.8fr_1fr_24px] md:items-center md:px-5">
                <div className="flex items-center gap-3">
                  <PairAvatar instrument={row.instrument} size={34} />
                  <div><p className="text-sm font-semibold">{displayNameFor(row.instrument)}</p><p className="mt-0.5 text-xs text-[color:var(--muted)]">{row.direction ?? row.session}</p></div>
                </div>
                <div className="metric-number text-xs"><p>{price(row.bid, row.instrument)} / {price(row.ask, row.instrument)}</p><p className="mt-1 text-[color:var(--muted)]">{row.spreadPips === null ? "—" : `${row.spreadPips.toFixed(1)} pips`}</p></div>
                <div><span className={status.className}>{status.label}</span>{row.batchNumber ? <p className="mt-1.5 text-xs text-[color:var(--muted)]">Batch {row.batchNumber}{row.tradeSequence ? ` · #${row.tradeSequence}` : ""}</p> : null}</div>
                <Levels row={row} availability={availability} />
                <div className="inline-flex items-center gap-1.5 text-xs text-[color:var(--muted)]"><Clock3 className="size-3.5" />{row.evaluatedAt ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(row.evaluatedAt)) : "Waiting"}</div>
                <ArrowUpRight className="hidden size-4 text-[color:var(--muted)] md:block" />
              </Link>
            );
          })}
          {!rows.length && loading ? <div className="p-8 text-center text-sm text-[color:var(--muted)]">Loading the monitored pairs…</div> : null}
        </div>
      </section>
    </div>
  );
}
