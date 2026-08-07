"use client";

import Link from "next/link";
import { ArrowUpRight, BarChart3, Radar, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AccountOverviewHero } from "@/components/dashboard/account-overview-hero";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatDayAndTime } from "@/lib/format/datetime";
import { getPaperTradingAvailability, type PaperTradingAvailability } from "@/lib/strategy/strategy-engine";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

export type DashboardWatchRow = {
  instrument: string;
  evaluatedAt: string | null;
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  conditions?: Array<{ name: string; passed: boolean; required: boolean }>;
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
  wins: number;
  losses: number;
  /** A fraction, not a percentage: wins / resolved. */
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
  paperPl?: number | null;
  openedAt: string;
  closedAt?: string | null;
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
  return formatDayAndTime(value);
}

/**
 * Per-pair state only.
 *
 * A closed entry window is the same for every pair, so it is reported once in
 * the section header instead of under all ten rows — a `label` of null means
 * this pair has nothing of its own to say, and the row stays a single line.
 * `state` also drives the row's status dot, so the colour beside a pair and the
 * words under it can never disagree.
 */
/** How much of the required checklist a pair currently passes, 0 to 1. */
function setupProgress(row: DashboardWatchRow) {
  const required = (row.conditions ?? []).filter((condition) => condition.required);
  if (!required.length) return 0;
  return required.filter((condition) => condition.passed).length / required.length;
}

/**
 * The dot tracks how close a pair is to a tradable setup, and keeps doing so
 * while the entry window is shut — that is exactly when a watchlist is worth
 * glancing at. Grey means nothing is forming, amber means the checklist is
 * filling in, green means every required condition passes.
 *
 * The label is separate and per-pair only: a closed window is the same fact for
 * all ten pairs, so it is stated once in the section header.
 */
function pairState(row: DashboardWatchRow, availability: PaperTradingAvailability) {
  const windowOpen = availability.state === "entry_window_open";

  if (row.openTradeId) return { label: "Open paper trade", tone: "text-[color:var(--accent)]", state: "open" };
  if (row.dataStatus !== "connected") {
    return { label: "Data unavailable", tone: "text-[color:var(--danger)]", state: "unavailable" };
  }
  if (row.setupStatus === "valid") {
    return { label: windowOpen ? "Entry ready" : null, tone: "text-[color:var(--success)]", state: "ready" };
  }
  if (row.setupStatus === "developing" || setupProgress(row) >= 0.6) {
    return { label: windowOpen ? "Developing" : null, tone: "text-[color:var(--pending)]", state: "developing" };
  }
  return { label: null, tone: "", state: "idle" };
}

function DashboardStat({
  label,
  value,
  detail,
  tone = "",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="dashboard-stat min-w-0 px-3 first:pl-0 last:pr-0">
      <div className="dashboard-stat-label">{label}</div>
      <div
        className={`metric-number text-lg font-semibold tracking-[-0.04em] sm:text-xl ${tone}`}
      >
        {value}
      </div>
      <div className="truncate text-[0.6875rem] text-[color:var(--muted)] sm:text-xs">
        {detail}
      </div>
    </div>
  );
}

export function DashboardView({
  initialAccount,
  initialWatchlist,
  initialOverview,
  userLabel,
  todayKey,
}: {
  initialAccount: AccountSummary;
  initialStatus: ConnectionStatus;
  initialWatchlist: DashboardWatchRow[];
  initialOverview: DashboardOverview;
  initialExposure: DashboardExposure;
  userLabel: string;
  todayKey: string;
}) {
  const [account, setAccount] = useState(initialAccount);
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  const availability = getPaperTradingAvailability();

  const refresh = useCallback(async () => {
    try {
      const [accountResponse, watchlistResponse, cycleResponse] = await Promise.all([
        fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-cycle"), { credentials: "include", cache: "no-store" }),
      ]);
      if (![accountResponse, watchlistResponse, cycleResponse].every((response) => response.ok)) {
        throw new Error("Dashboard data is temporarily unavailable.");
      }
      const [accountPayload, watchlistPayload, cyclePayload] = await Promise.all([
        accountResponse.json() as Promise<{ data: AccountSummary; status: ConnectionStatus }>,
        watchlistResponse.json() as Promise<{ watchlist: DashboardWatchRow[] }>,
        cycleResponse.json() as Promise<DashboardOverview>,
      ]);
      setAccount(accountPayload.data);
      setWatchlist(watchlistPayload.watchlist);
      setOverview(cyclePayload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dashboard data is temporarily unavailable.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const assigned = overview.current?.assignedCount ?? 0;
  const lifetime = overview.lifetimeSummary;
  const paperTrades = overview.trades.map((trade) => ({
    paperPl: trade.paperPl ?? null,
    closedAt: trade.closedAt ?? null,
    openedAt: trade.openedAt,
    status: trade.status,
  }));

  return (
    <div className="dashboard-view dashboard-minimal space-y-8 lg:space-y-10">
      <AccountOverviewHero
        account={account}
        userLabel={userLabel}
        trades={paperTrades}
        todayKey={todayKey}
      />

      {error ? <p className="research-error">{error}</p> : null}

      <section className="dashboard-minimal-section" aria-label="Strategy performance">
        <div className="grid grid-cols-3 divide-x divide-[color:var(--border)]">
          <DashboardStat
            label="Net"
            value={`${lifetime.netR >= 0 ? "+" : ""}${lifetime.netR.toFixed(2)}R`}
            detail={`${lifetime.resolved} closed`}
            tone={
              lifetime.resolved === 0
                ? ""
                : lifetime.netR >= 0
                  ? "text-[color:var(--success)]"
                  : "text-[color:var(--danger)]"
            }
          />
          {/* winRate arrives as a fraction (wins / resolved), like every other
              rate from /api/paper-cycle — the research views scale it the same
              way. Formatting it directly rendered 0.5 as "1%". */}
          <DashboardStat
            label="Win rate"
            value={lifetime.winRate === null ? "—" : `${(lifetime.winRate * 100).toFixed(0)}%`}
            detail={
              lifetime.resolved === 0
                ? "No closed trades"
                : `${lifetime.wins}W · ${lifetime.resolved - lifetime.wins}L`
            }
          />
          <DashboardStat
            label="Batch"
            value={`${assigned}/${overview.batchSize}`}
            detail={
              overview.current
                ? `Batch ${overview.current.batchNumber} · ${lifetime.open} open`
                : `${lifetime.open} open`
            }
          />
        </div>
      </section>

      <section className="dashboard-minimal-section" aria-label="Watchlist">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Watchlist</h2>
            {/* Said once here rather than under every pair. */}
            {availability.state !== "entry_window_open" ? (
              <span className="truncate text-xs text-[color:var(--muted)]">
                {availability.label}
              </span>
            ) : null}
          </div>
          <Link href="/watchlist" className="link-quiet pressable text-xs">
            View all
          </Link>
        </div>
        <div className="dashboard-watchlist-grid mt-3">
          {watchlist.map((row) => {
            const state = pairState(row, availability);
            return (
              <Link
                key={row.instrument}
                href={`/signals?instrument=${row.instrument}`}
                data-state={state.state}
                className="dashboard-minimal-row pressable flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayNameFor(row.instrument)}</p>
                  {state.label ? (
                    <p className={`mt-0.5 truncate text-xs ${state.tone}`}>{state.label}</p>
                  ) : null}
                </div>
                <p className="metric-number shrink-0 text-sm text-[color:var(--muted)]">
                  {row.bid === null ? "—" : formatChartPrice(row.bid, row.instrument)}
                </p>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="dashboard-minimal-grid">
        <section className="dashboard-minimal-section" aria-label="Recent paper trades">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Recent trades</h2>
            <Link href="/journal" className="link-quiet pressable text-xs">
              View all
            </Link>
          </div>
          {overview.trades.length ? (
            <div className="dash-trade-list mt-3">
              {overview.trades.slice(0, 6).map((trade) => {
                const plTone =
                  trade.paperPl === null || trade.paperPl === undefined
                    ? "is-open"
                    : trade.paperPl >= 0
                      ? "is-win"
                      : "is-loss";
                return (
                  <Link
                    key={trade.id}
                    href={`/signals?instrument=${trade.instrument}&trade=${trade.id}`}
                    className="dash-trade-card pressable"
                  >
                    <div className="dash-trade-main min-w-0">
                      {/* Direction stays neutral: in this row green and red mean
                          profit and loss, and a green "long" beside a red result
                          made one colour say two things. */}
                      <p className="dash-trade-title">
                        <span className="dash-trade-pair">
                          {displayNameFor(trade.instrument)}
                        </span>
                        <span className="dash-trade-dir">{trade.direction}</span>
                      </p>
                      <p className="dash-trade-time">{time(trade.openedAt)}</p>
                    </div>
                    <div className="dash-trade-aside">
                      <p className={`dash-trade-pl metric-number ${plTone}`}>
                        {trade.paperPl === null || trade.paperPl === undefined
                          ? "Open"
                          : money(trade.paperPl, account.currency)}
                      </p>
                      {trade.resultR !== null ? (
                        <p className="dash-trade-r metric-number">
                          {trade.resultR >= 0 ? "+" : ""}
                          {trade.resultR.toFixed(2)}R
                        </p>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[color:var(--muted)]">No paper trades yet.</p>
          )}
        </section>

        <section className="dashboard-minimal-actions" aria-label="Shortcuts">
          {(
            [
              ["Watch the market", "/watchlist", Radar],
              ["Analyze the batch", "/research", BarChart3],
              ["Review research risk", "/risk", WalletCards],
            ] as const
          ).map(([title, href, Icon]) => (
            <Link key={title} href={href} className="dashboard-minimal-action pressable">
              <Icon className="size-4 text-[color:var(--accent)]" strokeWidth={2} />
              <span>{title}</span>
              <ArrowUpRight className="ml-auto size-3.5 text-[color:var(--muted)]" />
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
