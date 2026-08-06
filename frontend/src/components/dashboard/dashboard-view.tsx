"use client";

import Link from "next/link";
import { ArrowUpRight, BarChart3, Radar, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AccountOverviewHero } from "@/components/dashboard/account-overview-hero";
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
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
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
  initialWatchlist,
  initialOverview,
  userLabel,
}: {
  initialAccount: AccountSummary;
  initialStatus: ConnectionStatus;
  initialWatchlist: DashboardWatchRow[];
  initialOverview: DashboardOverview;
  initialExposure: DashboardExposure;
  userLabel: string;
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
  const paperTrades = overview.trades.map((trade) => ({
    paperPl: trade.paperPl ?? null,
    closedAt: trade.closedAt ?? null,
    openedAt: trade.openedAt,
    status: trade.status,
  }));

  return (
    <div className="dashboard-view dashboard-minimal space-y-8 lg:space-y-10">
      <AccountOverviewHero account={account} userLabel={userLabel} trades={paperTrades} />

      {error ? <p className="research-error">{error}</p> : null}

      <section className="dashboard-minimal-section" aria-label="Watchlist">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Watchlist</h2>
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
                className="dashboard-minimal-row pressable flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayNameFor(row.instrument)}</p>
                  <p className={`mt-0.5 truncate text-xs ${state.tone}`}>{state.label}</p>
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
            <p className="metric-number text-xs text-[color:var(--muted)]">
              {assigned}/{overview.batchSize}
            </p>
          </div>
          {overview.trades.length ? (
            <div className="mt-3">
              {overview.trades.slice(0, 6).map((trade) => (
                <Link
                  key={trade.id}
                  href={`/signals?instrument=${trade.instrument}&trade=${trade.id}`}
                  className="dashboard-minimal-row pressable flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {displayNameFor(trade.instrument)}{" "}
                      <span className={trade.direction === "long" ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>
                        {trade.direction}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-[color:var(--muted)]">{time(trade.openedAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={`metric-number text-sm font-semibold ${
                        trade.paperPl === null || trade.paperPl === undefined
                          ? ""
                          : trade.paperPl >= 0
                            ? "text-[color:var(--success)]"
                            : "text-[color:var(--danger)]"
                      }`}
                    >
                      {trade.paperPl === null || trade.paperPl === undefined
                        ? "Open"
                        : money(trade.paperPl, account.currency)}
                    </p>
                    {trade.resultR !== null ? (
                      <p className="metric-number mt-0.5 text-[0.68rem] text-[color:var(--muted)]">
                        {trade.resultR.toFixed(2)}R
                      </p>
                    ) : null}
                  </div>
                </Link>
              ))}
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
