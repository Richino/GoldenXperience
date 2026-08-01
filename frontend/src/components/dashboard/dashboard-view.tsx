"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, BarChart3, Clock3, Radar, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import { getPaperTradingAvailability, type PaperTradingAvailability } from "@/lib/strategy/strategy-engine";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

export type DashboardWatchRow = {
  instrument: string;
  evaluatedAt: string | null;
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  direction: "long" | "short" | null;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  openTradeId: string | null;
  batchNumber: number | null;
  tradeSequence: string | null;
};

type Metrics = {
  assigned: number;
  open: number;
  resolved: number;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  netR: number;
  maxDrawdownR: number;
};

type Batch = {
  id: string;
  batchNumber: number;
  status: "collecting" | "resolving" | "complete";
  assignedCount: number;
  liveSummary?: Metrics;
  remaining?: number;
};

type Trade = {
  id: string;
  tradeSequence: string;
  instrument: string;
  direction: "long" | "short";
  status: string;
  outcome: string;
  resultR: number | null;
  openedAt: string;
};

export type DashboardOverview = {
  strategyVersion: string;
  batchSize: number;
  lifetimeSummary: Metrics;
  current: Batch | null;
  batches: Batch[];
  trades: Trade[];
};

export type DashboardExposure = {
  openTrades: number;
  totalNominalRiskPercent: number;
  totalNominalRiskAmount: number;
  currencyExposure: Array<{ code: string; nominalRiskPercent: number }>;
};

function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function time(value: string | null) {
  if (!value) return "Waiting";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function metric(value: number | null, suffix = "") {
  return value === null ? "—" : `${value.toFixed(2)}${suffix}`;
}

function pairState(row: DashboardWatchRow, availability: PaperTradingAvailability) {
  if (row.openTradeId) return { label: "Open paper trade", tone: "text-[color:var(--accent)]" };
  if (availability.state === "market_closed") return { label: "Market closed", tone: "text-[color:var(--muted)]" };
  if (availability.state === "waiting_for_entry_window") return { label: "Waiting", tone: "text-[color:var(--muted)]" };
  if (row.dataStatus !== "connected") return { label: "Data unavailable", tone: "text-[color:var(--danger)]" };
  if (row.setupStatus === "valid") return { label: "Entry ready", tone: "text-[color:var(--success)]" };
  if (row.setupStatus === "developing") return { label: "Developing", tone: "text-[color:var(--foreground)]" };
  return { label: "No setup", tone: "text-[color:var(--muted)]" };
}

export function DashboardView({
  initialAccount,
  initialStatus,
  initialWatchlist,
  initialOverview,
  initialExposure,
}: {
  initialAccount: AccountSummary;
  initialStatus: ConnectionStatus;
  initialWatchlist: DashboardWatchRow[];
  initialOverview: DashboardOverview;
  initialExposure: DashboardExposure;
}) {
  const [account, setAccount] = useState(initialAccount);
  const [status, setStatus] = useState(initialStatus);
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [overview, setOverview] = useState(initialOverview);
  const [exposure, setExposure] = useState(initialExposure);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = getPaperTradingAvailability();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [accountResponse, watchlistResponse, cycleResponse, riskResponse] = await Promise.all([
        fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-cycle"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-risk"), { credentials: "include", cache: "no-store" }),
      ]);
      if (![accountResponse, watchlistResponse, cycleResponse, riskResponse].every((response) => response.ok)) throw new Error("Dashboard data is temporarily unavailable.");
      const [accountPayload, watchlistPayload, cyclePayload, riskPayload] = await Promise.all([
        accountResponse.json() as Promise<{ data: AccountSummary; status: ConnectionStatus }>,
        watchlistResponse.json() as Promise<{ watchlist: DashboardWatchRow[] }>,
        cycleResponse.json() as Promise<DashboardOverview>,
        riskResponse.json() as Promise<{ exposure: DashboardExposure }>,
      ]);
      setAccount(accountPayload.data);
      setStatus(accountPayload.status);
      setWatchlist(watchlistPayload.watchlist);
      setOverview(cyclePayload);
      setExposure(riskPayload.exposure);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dashboard data is temporarily unavailable.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openPairs = watchlist.filter((row) => row.openTradeId).length;
  const readyPairs = availability.entryWindowOpen ? watchlist.filter((row) => !row.openTradeId && row.dataStatus === "connected" && row.setupStatus === "valid").length : 0;
  const unavailablePairs = availability.marketOpen ? watchlist.filter((row) => row.dataStatus !== "connected").length : 0;
  const current = overview.current;
  const summary = current?.liveSummary ?? { assigned: 0, open: 0, resolved: 0, winRate: null, averageR: null, profitFactor: null, netR: 0, maxDrawdownR: 0 };
  const assigned = current?.assignedCount ?? 0;
  const remaining = current?.remaining ?? overview.batchSize;
  const nextBatchNumber = current?.batchNumber ?? Math.max(0, ...overview.batches.map((batch) => batch.batchNumber)) + 1;
  const progress = Math.min(100, assigned);
  const latestEvaluation = useMemo(() => watchlist.map((row) => row.evaluatedAt).filter(Boolean).sort().at(-1) ?? null, [watchlist]);

  const collectorLabel = openPairs
    ? `Managing ${openPairs} open paper ${openPairs === 1 ? "trade" : "trades"}`
    : availability.state === "market_closed"
      ? "Collector waiting — market closed"
      : availability.state === "waiting_for_entry_window"
        ? "Collector waiting for entry window"
        : readyPairs
          ? `${readyPairs} setup${readyPairs === 1 ? "" : "s"} ready`
          : "Scanning ten pairs";

  return (
    <div className="dashboard-view space-y-5">
      <section className="app-card-hero p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-[color:var(--accent)]">Automatic paper collection</p>
            <h1 className="text-display mt-2">Strategy command center</h1>
            <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">One bundled strategy monitors ten fixed forex pairs and records accepted setups in immutable 100-trade batches.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="permission-pill bg-[color:var(--accent-soft)] text-[color:var(--accent)]" role="status"><Activity className="size-3.5" />{collectorLabel}</span>
            <button type="button" onClick={() => void refresh()} disabled={refreshing} className="secondary-button pressable inline-flex items-center gap-2"><RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</button>
          </div>
        </div>
        {error ? <p className="research-error mt-4">{error} Existing values remain visible.</p> : null}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div><SectionLabel title={`Batch ${nextBatchNumber}`} variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">{current ? `${current.status} · ${overview.strategyVersion} · fixed 1.5R target` : "Starts automatically when the next valid setup is accepted."}</p></div>
            <div className="metric-number text-right text-2xl font-semibold">{assigned}/{overview.batchSize}</div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-[color:var(--surface-raised)]"><div className="h-full rounded-full bg-[color:var(--accent)]" style={{ width: `${progress}%` }} /></div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[["Open", summary.open], ["Resolved", summary.resolved], ["Remaining", remaining], ["Average R", metric(summary.averageR, "R")]].map(([label, value]) => <div key={label} className="inset-panel rounded-2xl px-3.5 py-3"><p className="text-xs text-[color:var(--muted)]">{label}</p><p className="metric-number mt-1 text-lg font-semibold">{value}</p></div>)}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--border)] pt-4 text-xs text-[color:var(--muted)]"><span>Win rate {percent(summary.winRate)} · PF {metric(summary.profitFactor)} · Net {metric(summary.netR, "R")}</span><Link href="/research" className="link-quiet pressable inline-flex items-center gap-1">Open full batch analysis<ArrowUpRight className="size-3.5" /></Link></div>
        </section>

        <section className="app-card p-5 md:p-6">
          <div className="flex items-start gap-3"><div className="icon-tile-accent grid size-11 shrink-0 place-items-center rounded-2xl"><ShieldCheck className="size-5" /></div><div><SectionLabel title="Paper exposure" variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">Research exposure, not realistic live portfolio risk.</p></div></div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            {[["Open trades", exposure.openTrades], ["Nominal risk", `${exposure.totalNominalRiskPercent.toFixed(2)}%`], ["Nominal amount", money(exposure.totalNominalRiskAmount, account.currency)], ["Largest currency tilt", exposure.currencyExposure[0] ? `${exposure.currencyExposure[0].code} ${Math.abs(exposure.currencyExposure[0].nominalRiskPercent).toFixed(1)}%` : "None"]].map(([label, value]) => <div key={label} className="inset-panel rounded-2xl px-3.5 py-3"><p className="text-xs text-[color:var(--muted)]">{label}</p><p className="metric-number mt-1 text-sm font-semibold">{value}</p></div>)}
          </div>
          <p className="mt-4 text-xs leading-5 text-[color:var(--danger)]">Cross-pair collection intentionally ignores realistic portfolio correlation and daily-loss limits. No OANDA orders are submitted.</p>
          <div className="mt-3 text-right"><Link href="/risk" className="link-quiet pressable inline-flex items-center gap-1 text-xs">Review exposure<ArrowUpRight className="size-3.5" /></Link></div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3"><div><SectionLabel title="Collection status" variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">The schedule and broker state that control new paper entries.</p></div><span className="permission-pill bg-[color:var(--minimal-track)] text-[color:var(--foreground)]"><Clock3 className="size-3.5" />{availability.label}</span></div>
          <p className="mt-4 border-t border-[color:var(--border)] pt-4 text-sm leading-6">{availability.detail}</p>
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[color:var(--border)] pt-4">
            {[["OANDA account", status.state === "connected" ? "Connected" : status.label], ["Environment", status.environment], ["Account balance", money(account.balance, account.currency)], ["Last M15 evaluation", time(latestEvaluation)]].map(([label, value]) => <div key={label}><p className="text-xs text-[color:var(--muted)]">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>)}
          </div>
        </section>

        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3"><div><SectionLabel title="Ten-pair monitor" variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">Shared strategy snapshots—no separate scanner.</p></div><Radar className="size-5 text-[color:var(--accent)]" /></div>
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-[color:var(--border)] pt-4">
            {watchlist.map((row) => { const state = pairState(row, availability); return <Link key={row.instrument} href={`/signals?instrument=${row.instrument}`} className="pressable flex min-w-0 items-center justify-between gap-3 rounded-xl px-1 py-1.5"><div className="min-w-0"><p className="text-sm font-medium">{displayNameFor(row.instrument)}</p><p className={`mt-0.5 truncate text-xs ${state.tone}`}>{state.label}</p></div><p className="metric-number shrink-0 text-xs text-[color:var(--muted)]">{row.bid === null ? "—" : formatChartPrice(row.bid, row.instrument)}</p></Link>; })}
          </div>
          <div className="mt-4 flex flex-wrap justify-between gap-3 border-t border-[color:var(--border)] pt-4 text-xs text-[color:var(--muted)]"><span>{openPairs} open · {readyPairs} ready · {unavailablePairs} unavailable</span><Link href="/watchlist" className="link-quiet pressable inline-flex items-center gap-1">Open watchlist<ArrowUpRight className="size-3.5" /></Link></div>
        </section>
      </div>

      <section className="app-card overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-5 md:px-6"><div><SectionLabel title="Latest automatic paper trades" variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">Accepted trades from the current 100-trade batch—not manual Journal entries.</p></div><BarChart3 className="size-5 text-[color:var(--accent)]" /></div>
        {overview.trades.length ? <div>{overview.trades.slice(0, 6).map((trade) => <Link key={trade.id} href={`/signals?instrument=${trade.instrument}`} className="dashboard-row pressable flex items-center justify-between gap-3 px-5 py-3.5 md:px-6"><div><p className="text-sm font-medium">#{trade.tradeSequence} · {displayNameFor(trade.instrument)} <span className={trade.direction === "long" ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>{trade.direction}</span></p><p className="mt-0.5 text-xs text-[color:var(--muted)]">{time(trade.openedAt)} · {trade.status}</p></div><p className="metric-number text-sm font-semibold">{trade.resultR === null ? "Open" : `${trade.resultR.toFixed(2)}R`}</p></Link>)}</div> : <div className="border-t border-[color:var(--border)] px-5 py-7 md:px-6"><p className="empty-state"><span className="empty-state-dot" />No automatic paper trades yet. The first valid completed-M15 setup will start Batch 1.</p></div>}
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {[["Watch the market", "Ten fixed pairs and their current setup state.", "/watchlist", Radar], ["Analyze the batch", "Progress, metrics, trades, and evidence-based review.", "/research", BarChart3], ["Review research risk", "Nominal exposure and cross-pair currency concentration.", "/risk", WalletCards]].map(([title, body, href, Icon]) => <Link key={String(title)} href={String(href)} className="app-card pressable p-4"><Icon className="size-5 text-[color:var(--accent)]" /><p className="mt-3 text-sm font-semibold">{String(title)}</p><p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">{String(body)}</p></Link>)}
      </section>
    </div>
  );
}
