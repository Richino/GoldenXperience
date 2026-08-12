"use client";

import Link from "next/link";
import { ArrowUpRight, BarChart3, Radar, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AccountOverviewHero } from "@/components/dashboard/account-overview-hero";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatDayAndTime } from "@/lib/format/datetime";
import { openTradeProgress } from "@/lib/open-trade-progress";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useOpenPositionFills } from "@/lib/market-stream/use-open-positions";
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
  // Already returned by the overview endpoint; declared here so an open trade
  // can be marked to the live quote instead of just reading "Open".
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  nominalRiskAmount?: number | null;
};

export type DashboardOverview = {
  strategyVersion: string;
  batchSize: number;
  lifetimeSummary: Metrics;
  current: Batch | null;
  batches: Batch[];
  trades: Trade[];
  /** Closed trades across every batch, for the account chart. */
  accountTrades?: Array<{ tradeSequence?: number; paperPl: number | null; closedAt: string | null; openedAt: string; status: string }>;
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

  if (row.openTradeId) return { label: "Open", tone: "text-[color:var(--accent)]", state: "open" };
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

function checklistDetail(row: DashboardWatchRow, state: ReturnType<typeof pairState>) {
  if (state.state === "open") return row.tradeSequence ? `Trade #${row.tradeSequence} is open` : "Paper trade is open";
  if (state.state === "unavailable") return "Live market data unavailable";
  const required = (row.conditions ?? []).filter((condition) => condition.required);
  const missing = required.filter((condition) => !condition.passed);
  const activeBlocker = missing.find((condition) => condition.name !== "Session");
  if (!activeBlocker) {
    return row.setupStatus === "valid"
      ? "Setup ready for the next entry window"
      : "Monitoring liquidity levels for a valid sweep";
  }
  const activity: Record<string, string> = {
    "Market data": "Refreshing market data across M15, H1 and H4",
    Spread: "Monitoring spread before entry",
    News: "Checking the high-impact news window",
    "Setup score": "Waiting for the setup score to improve",
  };
  return activity[activeBlocker.name] ?? `Monitoring ${activeBlocker.name.toLowerCase()}`;
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
  // Ticks rather than the 60s refresh below, so an open trade's value moves
  // with the market instead of jumping once a minute.
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fills = useOpenPositionFills();
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

  /**
   * The account moves with every tick on an open position, so it is polled on
   * its own short cycle. The watchlist and cycle payloads are heavier and only
   * change when a candle closes, so they keep the slow one.
   *
   * Both run once immediately: the effect previously installed the interval and
   * nothing else, which left the page showing its server-rendered snapshot —
   * including a day figure of +$0.00 — for a full minute after load.
   */
  const refreshAccount = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data: AccountSummary };
      setAccount(payload.data);
    } catch {
      // The slow refresh below reports the outage.
    }
  }, []);

  useEffect(() => {
    // Both fetches resolve before they set state, so the update lands in a
    // promise continuation rather than synchronously during the effect. The
    // rule cannot see through the async call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAccount();
    const timer = window.setInterval(() => void refreshAccount(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshAccount]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const assigned = overview.current?.assignedCount ?? 0;
  const lifetime = overview.lifetimeSummary;
  // Account history spans batches; the recent-trades list below stays scoped to
  // the batch that is collecting.
  const paperTrades = (overview.accountTrades ?? overview.trades).map((trade) => ({
    tradeSequence: "tradeSequence" in trade ? Number(trade.tradeSequence) : undefined,
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
                className="dashboard-minimal-row pressable block py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{displayNameFor(row.instrument)}</p>
                    <p className={`mt-0.5 truncate text-xs ${state.tone}`}>{checklistDetail(row, state)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="metric-number text-sm text-[color:var(--muted)]">
                      {/* Streamed price when the pair has ticked, otherwise the
                          polled snapshot. */}
                      {(() => {
                        const shownBid = quotes[row.instrument]?.bid ?? row.bid;
                        return shownBid === null ? "—" : formatChartPrice(shownBid, row.instrument);
                      })()}
                    </p>
                    {state.state !== "open" && state.state !== "unavailable" ? (
                      <p className="watchlist-checklist-value mt-0.5 text-xs font-medium">
                        {Math.round((state.state === "ready" ? 1 : setupProgress(row)) * 100)}% checklist
                      </p>
                    ) : null}
                  </div>
                </div>
                {state.state !== "open" && state.state !== "unavailable" ? (
                  <div
                    className="mt-2 h-1 overflow-hidden rounded-full bg-[color:var(--border)]"
                    role="progressbar"
                    aria-label={`${displayNameFor(row.instrument)} checklist completion`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((state.state === "ready" ? 1 : setupProgress(row)) * 100)}
                  >
                    <span
                      className={`block h-full rounded-full ${state.state === "ready" ? "bg-[color:var(--success)]" : state.state === "developing" ? "bg-[color:var(--pending)]" : "bg-[color:var(--muted)]"}`}
                      style={{ width: `${Math.round((state.state === "ready" ? 1 : setupProgress(row)) * 100)}%` }}
                    />
                  </div>
                ) : null}
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
                const settled = trade.paperPl !== null && trade.paperPl !== undefined;
                // An open trade is marked against the live quote for its pair,
                // so the row reports what it is worth now rather than "Open".
                const streamed = quotes[trade.instrument];
                const quote =
                  streamed ?? watchlist.find((row) => row.instrument === trade.instrument);
                const live =
                  settled ||
                  trade.entry == null ||
                  trade.stop == null ||
                  trade.target == null
                    ? null
                    : openTradeProgress({
                        direction: trade.direction,
                        entry: trade.entry,
                        stop: trade.stop,
                        target: trade.target,
                        bid: quote?.bid,
                        ask: quote?.ask,
                        riskAmount: trade.nominalRiskAmount,
                        fill: fills[trade.instrument],
                      });
                const shown = settled ? trade.paperPl! : live?.money ?? null;
                const plTone =
                  shown === null ? "is-open" : shown >= 0 ? "is-win" : "is-loss";
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
                        {shown === null ? "Open" : money(shown, account.currency)}
                      </p>
                      {trade.resultR !== null ? (
                        <p className="dash-trade-r metric-number">
                          {trade.resultR >= 0 ? "+" : ""}
                          {trade.resultR.toFixed(2)}R
                        </p>
                      ) : live ? (
                        <p className="dash-trade-r metric-number">
                          {Math.round(live.percent)}%{" "}
                          {live.towards === "stop" ? "to SL" : "to TP"}
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
