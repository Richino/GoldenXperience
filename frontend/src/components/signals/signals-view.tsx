"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, SlidersHorizontal, Zap } from "lucide-react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { TopPairSearch } from "@/components/layout/top-pair-search";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatDayAndTime } from "@/lib/format/datetime";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { todayClosedStats } from "@/lib/home/idle";
import {
  RECENT_OUTCOME_LABEL,
  buildActiveSignals,
  buildRecentSignals,
  signalProgress,
  type ActiveSignal,
  type SignalPlan,
  type SignalStatus,
} from "@/lib/signals/build";
import type { StrategySetup } from "@/lib/strategy/types";
import type { JournalTrade } from "@/types/forex";

const STATUS_LABEL: Record<SignalStatus, string> = {
  active: "Active",
  watching: "Watching",
  triggered: "Triggered",
};

const FILTERS = ["Pair", "Side", "Strategy", "H1", "Status"];

function rrLabel(riskReward: number | null) {
  if (riskReward === null) return "—";
  const rounded = Math.round(riskReward * 10) / 10;
  return `1:${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}`;
}

function signedR(value: number | null) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}R`;
}

function StatusPill({ status }: { status: SignalStatus }) {
  return (
    <span className={`signal-status is-${status}`}>
      {status === "active" ? (
        <span className="signal-status-dot" aria-hidden="true" />
      ) : status === "watching" ? (
        <Eye className="signal-status-icon" strokeWidth={2} />
      ) : (
        <Zap className="signal-status-icon" strokeWidth={2} />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

function SignalCard({ signal }: { signal: ActiveSignal }) {
  const fraction = signalProgress(signal);
  const openR =
    signal.current === null || signal.entry === signal.stop
      ? null
      : ((signal.current - signal.entry) / Math.abs(signal.entry - signal.stop)) *
        (signal.direction === "long" ? 1 : -1);

  const foot =
    signal.status === "watching"
      ? signal.note ?? "Awaiting confirmation"
      : signal.status === "triggered"
        ? `Filled ${formatChartPrice(signal.fillPrice ?? signal.entry, signal.instrument)}${
            signal.lots !== null ? ` · ${signal.lots.toFixed(2)} lot` : ""
          }`
        : `Risk ${signal.riskPercent.toFixed(1)}%${
            signal.lots !== null ? ` · ${signal.lots.toFixed(2)} lot` : ""
          }`;

  return (
    <article className={`signal-card is-${signal.status}`}>
      <div className="signal-card-head">
        <div className="signal-card-ident">
          <span className="signal-card-pair">{signal.pair}</span>
          <span className={`home-side is-${signal.direction}`}>
            {signal.direction === "long" ? "LONG" : "SHORT"}
          </span>
          <span className="signal-card-strategy">
            {signal.strategy} · {signal.timeframe}
          </span>
        </div>
        <div className="signal-card-meta">
          <span className="signal-card-time">
            <RelativeTime at={signal.evaluatedAt} />
          </span>
          <StatusPill status={signal.status} />
        </div>
      </div>

      <dl className="signal-card-stats">
        <div>
          <dt>Entry</dt>
          <dd className="metric-number">{formatChartPrice(signal.entry, signal.instrument)}</dd>
        </div>
        <div>
          <dt>Stop loss</dt>
          <dd className="metric-number is-negative">
            {formatChartPrice(signal.stop, signal.instrument)}
          </dd>
        </div>
        <div>
          <dt>Take profit</dt>
          <dd className="metric-number">{formatChartPrice(signal.target, signal.instrument)}</dd>
        </div>
        <div>
          <dt>R:R</dt>
          <dd className="metric-number">{rrLabel(signal.riskReward)}</dd>
        </div>
        <div className="signal-card-current">
          <dt>Current</dt>
          <dd className="metric-number">
            {signal.current === null ? "—" : formatChartPrice(signal.current, signal.instrument)}
          </dd>
        </div>
      </dl>

      <div className="signal-progress">
        <div className="signal-progress-track">
          <span className="signal-progress-dot is-stop" aria-hidden="true" />
          <span
            className="signal-progress-knob"
            style={{ left: `${fraction * 100}%` }}
            aria-hidden="true"
          />
          <span className="signal-progress-dot is-target" aria-hidden="true" />
        </div>
        <div className="signal-progress-labels">
          <span hidden={fraction < 0.22}>{formatChartPrice(signal.stop, signal.instrument)}</span>
          <span
            className="signal-progress-now"
            style={{ left: `${Math.min(85, Math.max(15, fraction * 100))}%` }}
          >
            {signal.current === null ? "—" : formatChartPrice(signal.current, signal.instrument)} NOW
          </span>
          <span hidden={fraction > 0.78}>{formatChartPrice(signal.target, signal.instrument)}</span>
        </div>
      </div>

      <div className="signal-card-foot">
        <span className="signal-card-note">
          {foot}
          {openR !== null ? <span className="signal-card-openr"> · {signedR(openR)} open</span> : null}
        </span>
        <Link href={`/chart?instrument=${signal.instrument}`} className="signal-card-chart">
          View chart →
        </Link>
      </div>
    </article>
  );
}

function RecentList({ items }: { items: ReturnType<typeof buildRecentSignals> }) {
  if (!items.length) {
    return <p className="signal-empty">No closed signals yet.</p>;
  }
  return (
    <div className="signal-recent-list">
      <div className="signal-recent-head" aria-hidden="true">
        <span>Pair</span>
        <span>Side</span>
        <span className="signal-recent-strategy">Strategy</span>
        <span>Status</span>
        <span className="signal-recent-result">Result</span>
        <span className="signal-recent-closed">Closed</span>
      </div>
      {items.map((item) => (
        <Link
          key={item.id}
          href={`/chart?instrument=${item.instrument}`}
          className={`signal-recent-row is-${item.outcome}`}
        >
          <span className="signal-recent-pair">{item.pair}</span>
          <span className={`home-side is-${item.direction}`}>
            {item.direction === "long" ? "LONG" : "SHORT"}
          </span>
          <span className="signal-recent-strategy">{item.strategy}</span>
          <span className="signal-recent-status">{RECENT_OUTCOME_LABEL[item.outcome]}</span>
          <span className="signal-recent-result metric-number">{signedR(item.resultR)}</span>
          <span className="signal-recent-closed">
            {item.closedAt ? formatDayAndTime(item.closedAt) : "—"}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function SignalsView({
  initialSetups,
  initialPlans,
  initialJournal,
  todayKey,
  initialQuotes,
}: {
  initialSetups: StrategySetup[];
  initialPlans: SignalPlan[];
  initialJournal: { trades: JournalTrade[] };
  todayKey: string;
  /** Seed prices so the cards read before the live socket connects. */
  initialQuotes?: Record<string, { bid: number; ask: number }>;
}) {
  const [setups, setSetups] = useState(initialSetups);
  const [plans, setPlans] = useState(initialPlans);
  const [journalTrades, setJournalTrades] = useState(initialJournal.trades);
  const [tab, setTab] = useState<"active" | "history">("active");
  const liveQuotes = useLiveQuotes();
  const quotes = useMemo(
    () => ({ ...(initialQuotes ?? {}), ...liveQuotes }),
    [initialQuotes, liveQuotes],
  );

  const refresh = useCallback(async () => {
    try {
      const [strategyResponse, watchlistResponse, journalResponse] = await Promise.all([
        fetch(apiUrl("/api/strategy"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/journal/trades?limit=50&filter=all"), {
          credentials: "include",
          cache: "no-store",
        }),
      ]);
      if (strategyResponse.ok) {
        const payload = (await strategyResponse.json()) as { strategy?: { setups?: StrategySetup[] } };
        if (payload.strategy?.setups) setSetups(payload.strategy.setups);
      }
      if (watchlistResponse.ok) {
        const payload = (await watchlistResponse.json()) as { watchlist?: SignalPlan[] };
        if (payload.watchlist) setPlans(payload.watchlist);
      }
      if (journalResponse.ok) {
        const payload = (await journalResponse.json()) as { trades?: JournalTrade[] };
        if (payload.trades) setJournalTrades(payload.trades);
      }
    } catch {
      // The last snapshot stays on screen until the next tick succeeds.
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useForegroundRefresh(refresh);

  const activeSignals = useMemo(
    () => buildActiveSignals(setups, plans, quotes),
    [setups, plans, quotes],
  );
  const recent = useMemo(() => buildRecentSignals(journalTrades, 20), [journalTrades]);
  const today = useMemo(() => todayClosedStats(journalTrades, todayKey), [journalTrades, todayKey]);

  const counts = useMemo(() => {
    const base = { active: 0, watching: 0, triggered: 0 };
    for (const signal of activeSignals) base[signal.status] += 1;
    return base;
  }, [activeSignals]);

  const resolved = today.wins + today.losses;
  const winRate = resolved > 0 ? (today.wins / resolved) * 100 : null;

  return (
    <div className="signals-list-shell">
      <div className="signals-list-main">
        <header className="signals-list-header">
          <div className="signals-list-title">
            <h1>Signals</h1>
            <span className="signals-list-count">
              <span className="signals-list-count-dot" aria-hidden="true" />
              {counts.active} active
              <span className="signals-list-count-sep lg:inline">
                {" "}
                · {counts.watching} watching
              </span>
            </span>
          </div>
          <div className="signals-list-tools">
            <div className="signals-list-search">
              <TopPairSearch />
            </div>
            <button type="button" className="signals-filter-icon" aria-label="Filter signals">
              <SlidersHorizontal className="size-4" strokeWidth={2} />
            </button>
          </div>
        </header>

        <div className="signals-list-tabs">
          <button
            type="button"
            className={`signals-list-tab ${tab === "active" ? "is-active" : ""}`}
            onClick={() => setTab("active")}
          >
            Active
          </button>
          <button
            type="button"
            className={`signals-list-tab ${tab === "history" ? "is-active" : ""}`}
            onClick={() => setTab("history")}
          >
            History
          </button>
          <div className="signals-list-filters">
            {FILTERS.map((filter) => (
              <button key={filter} type="button" className="signals-filter-chip">
                {filter} <span aria-hidden="true">▾</span>
              </button>
            ))}
          </div>
        </div>

        {tab === "active" ? (
          <>
            <section aria-label="Active signals">
              <p className="signals-section-label">Active now</p>
              {activeSignals.length ? (
                <div className="signal-card-grid">
                  {activeSignals.map((signal) => (
                    <SignalCard key={signal.instrument} signal={signal} />
                  ))}
                </div>
              ) : (
                <p className="signal-empty">No active signals right now.</p>
              )}
            </section>

            <section aria-label="Recent signals">
              <div className="signals-section-head">
                <p className="signals-section-label">Recent</p>
                <button
                  type="button"
                  className="signals-section-link"
                  onClick={() => setTab("history")}
                >
                  See all
                </button>
              </div>
              <RecentList items={recent.slice(0, 5)} />
            </section>
          </>
        ) : (
          <section aria-label="Signal history">
            <p className="signals-section-label">History</p>
            <RecentList items={recent} />
          </section>
        )}
      </div>

      <aside className="signals-list-rail" aria-label="Signal overview">
        <section className="signals-rail-section">
          <p className="signals-rail-label">Signal overview</p>
          <dl className="signals-rail-overview">
            <div>
              <dt>Active</dt>
              <dd className="is-positive">{counts.active}</dd>
            </div>
            <div>
              <dt>Watching</dt>
              <dd className="is-watching">{counts.watching}</dd>
            </div>
            <div>
              <dt>Triggered</dt>
              <dd>{counts.triggered}</dd>
            </div>
          </dl>
        </section>

        <section className="signals-rail-section">
          <p className="signals-rail-label">Today&rsquo;s results</p>
          <div className="signals-rail-today">
            <p className={`signals-rail-r ${today.netR === null || today.netR >= 0 ? "is-positive" : "is-negative"}`}>
              {signedR(today.netR)}
            </p>
            <p className="signals-rail-closed">{today.trades} closed</p>
          </div>
          <dl className="signals-rail-meta">
            <div>
              <dt>Wins</dt>
              <dd>{today.wins}</dd>
            </div>
            <div>
              <dt>Losses</dt>
              <dd>{today.losses}</dd>
            </div>
            <div>
              <dt>Win rate</dt>
              <dd>{winRate === null ? "—" : `${winRate.toFixed(1)}%`}</dd>
            </div>
          </dl>
          <div className="signals-rail-bar" aria-hidden="true">
            {winRate === null ? null : (
              <>
                <span className="is-win" style={{ width: `${winRate}%` }} />
                <span className="is-loss" style={{ width: `${100 - winRate}%` }} />
              </>
            )}
          </div>
        </section>

        <section className="signals-rail-section">
          <p className="signals-rail-label">Markets with signals</p>
          <div className="signals-rail-markets">
            {activeSignals.length ? (
              activeSignals.map((signal) => (
                <Link
                  key={signal.instrument}
                  href={`/chart?instrument=${signal.instrument}`}
                  className="signals-rail-market"
                >
                  <span>{signal.pair}</span>
                  <span className={`home-side is-${signal.direction}`}>
                    {signal.direction === "long" ? "LONG" : "SHORT"}
                  </span>
                  <span className={`signals-rail-market-status is-${signal.status}`}>
                    {STATUS_LABEL[signal.status]}
                  </span>
                </Link>
              ))
            ) : (
              <p className="signal-empty">No markets with signals.</p>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}
