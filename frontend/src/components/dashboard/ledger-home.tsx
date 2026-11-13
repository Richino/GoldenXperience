"use client";

/**
 * Home, as drawn in the Night Ledger canvas ("Portfolio — Desktop / Mobile").
 *
 * Purely presentational: DashboardView owns every fetch, poll and live-quote
 * subscription and hands this tree finished numbers. Layout and the desktop /
 * phone differences live in night-ledger.css (the `nl-` classes); the markup is
 * one tree for both, re-ordered on phones so positions, Today, news and pending
 * follow the balance in the canvas order.
 */

import Link from "next/link";
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  AccountAmountChart,
  AccountRangeControl,
  buildAccountAmountSeries,
  type AccountChartRange,
} from "@/components/dashboard/account-amount-chart";
import { NewsImpactSheet } from "@/components/dashboard/news-impact-sheet";
import { WeeklyReview } from "@/components/dashboard/weekly-review";
import { useHomeSectionReady } from "@/components/dashboard/home-loading-boundary";
import type { HomeCurrentPosition } from "@/components/dashboard/home-rail";
import { TopPairSearch } from "@/components/layout/top-pair-search";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ServiceNotice } from "@/components/ui/service-notice";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime, formatShortDay, tradingDayKey } from "@/lib/format/datetime";
import { accountQuota, quotaDayKey } from "@/lib/home/account-quota";
import type { HomeActivityItem } from "@/lib/home/idle";
import { displayNameFor } from "@/lib/instruments/catalog";
import { groupedCalendarTitle, groupSimultaneousRows, homeCalendarEmptyMessage, homeCalendarImpactTier, homeCalendarRows } from "@/lib/news/home-calendar";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import type { PublicNewsRun } from "@/lib/news/news-straddle-v3";
import { pendingLevelPrice, pendingStatusLabel, pendingTimingNote } from "@/lib/pending-entry/plain-language";
import { getMarketCondition } from "@/lib/strategy/session";
import { useScrolledPast } from "@/lib/use-scrolled-past";
import type { AccountBalanceHistoryPoint, AccountSummary } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

/* ------------------------------------------------------------------ types */

type LoadState = "loading" | "ready" | "stale" | "error";
export type DashboardLoadState = Record<"account" | "history" | "positions" | "journal" | "pending", LoadState>;
const READY: DashboardLoadState = { account: "ready", history: "ready", positions: "ready", journal: "ready", pending: "ready" };
const hasData = (state: LoadState) => state === "ready" || state === "stale";

function DeferredCard({ title, state }: { title: string; state: LoadState }) {
  return <section className="nl-card" aria-label={title} aria-busy={state === "loading"}>
    <h2>{title}</h2><p className="nl-card-empty" role="status">{state === "loading" ? `Loading ${title.toLowerCase()}…` : `${title} unavailable. Retrying automatically.`}</p>
  </section>;
}

export type LedgerPosition = {
  id: string;
  href: string;
  instrument: string;
  direction: "long" | "short";
  openedAt: string;
  entry: number | null;
  mark: number | null;
  stop: number | null;
  target: number | null;
  /** Where entry and mark sit on the stop → target line, 0–100. */
  entryAt: number | null;
  markAt: number | null;
  /** Open R at two decimals; 0 reads as flat. */
  r: number | null;
  money: number | null;
  lots: number | null;
  /** "52% to target" / "1.2 pips against", or null when unpriced. */
  progress: string | null;
  /** What OANDA booked for the entry spread, account currency; null when unknown. */
  spreadCost: number | null;
  /** That spread as a share of the trade's 1R (negative); null when unknown. */
  spreadR: number | null;
};

export type LedgerToday = {
  net: number | null;
  r: number | null;
  trades: number;
  wins: number;
  losses: number;
  /** R of each trade closed today, oldest first, for the bar strip. */
  results: number[];
};

/* ---------------------------------------------------------------- helpers */

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

function signedMoney(value: number, currency: string) {
  if (Math.abs(value) < 0.005) return money(0, currency);
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value), currency)}`;
}

function signedR(value: number | null, digits = 2) {
  if (value === null) return "—";
  const shown = Number(value.toFixed(digits)) || 0;
  return `${shown > 0 ? "+" : shown < 0 ? "−" : ""}${Math.abs(shown).toFixed(digits)}R`;
}

function tone(value: number | null | undefined, flat = 0.005) {
  if (value === null || value === undefined || Math.abs(value) < flat) return "is-flat";
  return value > 0 ? "is-up" : "is-down";
}

/** "$25,418" and ".62", so the cents can sit quieter than the dollars. */
function splitMoney(value: number, currency: string) {
  const text = money(value, currency);
  const dot = text.lastIndexOf(".");
  return dot === -1 ? [text, ""] : [text.slice(0, dot), text.slice(dot)];
}

function heldFor(openedAt: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(openedAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function countdown(timestamp: string, now: number) {
  const minutes = Math.max(0, Math.round((Date.parse(timestamp) - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const etDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });

const ORDER_TYPE_LABEL: Record<PendingManualEntry["entryOrderType"], string> = {
  buy_limit: "Buy limit",
  buy_stop: "Buy stop",
  sell_limit: "Sell limit",
  sell_stop: "Sell stop",
};

/** A wall clock that only exists after mount, so SSR and hydration agree. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null);
  // Set before the first paint, so a card that mounts as Home is revealed
  // (the hero's daily and weekly quotas) never shows "—" for a frame.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const WIDE_QUERY = "(min-width: 1024px)";

/**
 * Desktop layout or not. The server cannot know, so it renders the phone
 * version of anything gated on this and the desktop catches up on hydration.
 */
function useWide() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

function useMarketSession() {
  const now = useNow(30_000);
  if (now === null) return null;
  const condition = getMarketCondition(new Date(now));
  const label = !condition.marketOpen
    ? "Market closed"
    : condition.label === "London / New York"
      ? "London + New York open"
      : `${condition.label} open`;
  return { open: condition.marketOpen, label, clock: `${formatClockTime(now)} ET` };
}

/* ------------------------------------------------------------- icons */

function SideChip({ direction, children }: { direction: "long" | "short"; children: React.ReactNode }) {
  return <span className={`nl-side ${direction === "long" ? "is-up" : "is-down"}`}>{children}</span>;
}

/* ------------------------------------------------------------- header */

function LedgerHeader({ dateLabel, greeting }: { dateLabel: string; greeting: string }) {
  const session = useMarketSession();
  return (
    <header className="nl-home-top">
      <div className="nl-home-greet">
        <span className="nl-overline">{dateLabel}</span>
        <span className="nl-home-hello">{greeting}</span>
      </div>
      <div className="nl-home-tools">
        <TopPairSearch />
        <span className={`nl-session-pill${session?.open === false ? " is-closed" : ""}`}>
          <span className="nl-session-dot" aria-hidden="true" />
          {session?.label ?? "Session"}
          <span className="nl-session-clock metric-number">{session?.clock ?? "— ET"}</span>
        </span>
        <NotificationBell className="nl-bell" />
      </div>
    </header>
  );
}

function LedgerMobileHeader({ greeting }: { greeting: string }) {
  const session = useMarketSession();
  return (
    <header className="nl-home-mtop">
      <div className="nl-home-mtop-ident">
        <span className="nl-home-mtop-copy">
          <span className="nl-home-hello">{greeting}</span>
          <span className="nl-home-mtop-session">
            <span className={`nl-session-dot${session?.open === false ? " is-closed" : ""}`} aria-hidden="true" />
            {session?.label ?? "Session"} · <span className="metric-number">{session?.clock ?? "— ET"}</span>
          </span>
        </span>
      </div>
      <NotificationBell compact className="nl-bell" />
    </header>
  );
}

/* --------------------------------------------------------------- hero */

function LedgerHero({
  account,
  history,
  todayKey,
  openPL,
  historyState = "ready",
  financialUpdatedAt,
}: {
  account: AccountSummary;
  history: AccountBalanceHistoryPoint[];
  todayKey: string;
  openPL: number;
  historyState?: LoadState;
  financialUpdatedAt?: string | null;
}) {
  const historyAvailable = hasData(historyState);
  const [range, setRange] = useState<AccountChartRange>("1d");
  const now = useNow(30_000);
  const quotaDate = now === null ? null : quotaDayKey(now);
  const quota = useMemo(
    () => historyAvailable && quotaDate !== null ? accountQuota(account.balance, history, quotaDate) : null,
    [account.balance, history, historyAvailable, quotaDate],
  );
  const quotaMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: account.currency });
  const wide = useWide();
  const { ref: balanceRef, scrolledPast } = useScrolledPast<HTMLHeadingElement>();
  const series = useMemo(
    () => buildAccountAmountSeries({ nav: account.nav, unrealizedPL: account.unrealizedPL, history, range }),
    [account.nav, account.unrealizedPL, history, range],
  );
  // Broker balance movements booked this quota day (rolls over at 1 AM ET, on
  // the live clock), so "Realized today" always equals the daily quota's
  // realized figure. Before the clock is read (first render), fall back to the
  // server's ET date so server and client markup agree.
  const realizedPL = useMemo(
    () => quota
      ? quota.daily.realized
      : history.reduce((sum, point) => (tradingDayKey(point.time) === todayKey ? sum + point.change : sum), 0),
    [history, todayKey, quota],
  );
  const dayPL = realizedPL + account.unrealizedPL;
  const opening = account.nav - dayPL;
  const changePercent = opening !== 0 ? (dayPL / opening) * 100 : 0;
  const dayTone = historyAvailable ? tone(dayPL) : "is-flat";
  const [dollars, cents] = splitMoney(account.nav, account.currency);
  const percentLabel = historyAvailable ? `${changePercent >= 0 ? "+" : "−"}${Math.abs(changePercent).toFixed(2)}%` : "—";

  return (
    <section className="nl-hero" aria-label="Account overview" data-financial-snapshot-at={financialUpdatedAt ?? undefined}>
      {/* Phone: the balance stays pinned once the hero scrolls away. */}
      <div className={`nl-mbar${scrolledPast ? " is-visible" : ""}`} aria-hidden={!scrolledPast}>
        <span className="nl-mbar-balance">{money(account.nav, account.currency)}</span>
        <div className="nl-mbar-actions">
          <span className={`nl-chip ${dayTone}`}>{percentLabel}</span>
          <NotificationBell compact className="nl-bell nl-mbar-bell" />
        </div>
      </div>

      <div className="nl-hero-copy">
        <h1 ref={balanceRef} className="nl-hero-balance">
          {dollars}
          <span className="nl-hero-cents">{cents}</span>
        </h1>
        <div className="nl-hero-change">
          <span className={`nl-chip ${dayTone}`}>
            {dayTone !== "is-flat" ? <ArrowUpRight className={`nl-chip-arrow ${dayTone}`} aria-hidden="true" /> : null}
            {historyAvailable ? signedMoney(dayPL, account.currency) : "—"}
          </span>
          <span className={`nl-hero-pct metric-number ${dayTone}`}>{percentLabel} today</span>
          {historyAvailable ? <span className="nl-hero-open">from {money(opening, account.currency)} at the open</span> : null}
          {financialUpdatedAt ? <span className="nl-hero-open" title="Balance, chart, daily totals and broker position P/L refresh together.">Synced {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(financialUpdatedAt))} ET</span> : null}
        </div>
      </div>

      <AccountRangeControl range={range} onRangeChange={setRange} className="nl-range-tabs" />

      <div className="nl-chart-card">
        {historyAvailable ? <AccountAmountChart
          series={series}
          currency={account.currency}
          range={range}
          onRangeChange={setRange}
          hideRangeRow
          variant="ledger"
          scales={wide}
        /> : <p className="nl-card-empty" role="status">{historyState === "loading" ? "Loading account history…" : "Account history unavailable. Retrying automatically."}</p>}
        {historyState === "stale" ? <p className="nl-card-empty is-warn">Account history could not refresh. Historical totals may be outdated.</p> : null}
      </div>

      <dl className="nl-stats">
        <div>
          <dt>Realized today</dt>
          <dd className={`metric-number ${tone(realizedPL)}`}>{historyAvailable ? signedMoney(realizedPL, account.currency) : "—"}</dd>
        </div>
        <div>
          <dt>Unrealized</dt>
          <dd className={`metric-number ${tone(openPL)}`}>{signedMoney(openPL, account.currency)}</dd>
        </div>
        {(["daily", "weekly"] as const).map((period) => {
          const result = quota?.[period];
          return (
            <div key={period}>
              <dt>{period === "daily" ? "Daily quota" : "Weekly quota"}</dt>
              <dd className="metric-number">
                {result ? <>
                  <span className={tone(result.realized)}>{signedMoney(result.realized, account.currency)}</span>
                  <span className="nl-stat-quota-target">
                    {result.realized >= result.target
                      ? " · Quota met"
                      : ` of ${quotaMoney.format(Math.max(0, result.target))}`}
                  </span>
                </> : "—"}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/* ----------------------------------------------------------- sections */

function SectionHead({
  number,
  title,
  id,
  aside,
}: {
  number: string;
  title: string;
  id: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="nl-sec-head">
      <div className="nl-sec-title">
        <span className="nl-sec-num" aria-hidden="true">{number}</span>
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
    </div>
  );
}

export function LedgerPositions({
  positions,
  currency,
  closeAllCount = 0,
  onCloseAll,
}: {
  positions: LedgerPosition[];
  currency: string;
  /** Open manual trades Close all would act on; the button hides at 0. */
  closeAllCount?: number;
  onCloseAll?: () => void;
}) {
  const now = useNow(30_000);
  return (
    <section className="nl-sec nl-positions" aria-labelledby="nl-positions-title">
      <div className="nl-sec-head">
        <div className="nl-sec-title">
          <span className="nl-sec-num" aria-hidden="true">01</span>
          <h2 id="nl-positions-title">Open positions</h2>
          <span className="nl-count">
            {positions.length}
            <span className="nl-wide-only"> live</span>
          </span>
        </div>
        <div className="nl-sec-actions">
          {onCloseAll && closeAllCount > 0 ? (
            <button type="button" className="nl-close-all pressable" onClick={onCloseAll}>
              Close all
            </button>
          ) : null}
          <Link href="/journal" className="nl-sec-link">
            <span className="nl-wide-only">Journal</span>
            <span className="nl-narrow-only">See all</span>
            <ArrowUpRight aria-hidden="true" className="nl-wide-only" />
          </Link>
        </div>
      </div>

      {positions.length ? (
        <>
          <div className="nl-pos-head" aria-hidden="true">
            <span>Pair</span>
            <span>Entry → Mark</span>
            <span>Stop → Target</span>
            <span>Size</span>
            <span>R</span>
            <span>P/L</span>
          </div>
          {positions.map((position) => {
            const rTone = tone(position.r);
            const fillFrom = position.entryAt !== null && position.markAt !== null ? Math.min(position.entryAt, position.markAt) : null;
            const fillTo = position.entryAt !== null && position.markAt !== null ? Math.max(position.entryAt, position.markAt) : null;
            const sideLabel = position.direction === "long" ? "Long" : "Short";
            return (
              <Link key={position.id} href={position.href} className="nl-pos">
                <span className="nl-pos-pair">
                  <b>{displayNameFor(position.instrument)}</b>
                  <SideChip direction={position.direction}>
                    {sideLabel}
                    <span className="nl-wide-only">{now !== null ? ` · ${heldFor(position.openedAt, now)}` : ""}</span>
                    <span className="nl-narrow-only">{position.lots !== null ? ` · ${position.lots.toFixed(2)} lot` : ""}</span>
                  </SideChip>
                </span>
                <span className="nl-pos-prices metric-number">
                  <span className="nl-pos-entry">{position.entry === null ? "—" : formatChartPrice(position.entry, position.instrument)}</span>
                  <span>{position.mark === null ? "—" : formatChartPrice(position.mark, position.instrument)}</span>
                </span>
                <span className="nl-pos-track">
                  <span className="nl-track" aria-hidden="true">
                    {fillFrom !== null && fillTo !== null ? (
                      <span className={`nl-track-fill ${rTone}`} style={{ left: `${fillFrom}%`, width: `${fillTo - fillFrom}%` }} />
                    ) : null}
                    {position.entryAt !== null ? <span className="nl-track-entry" style={{ left: `${position.entryAt}%` }} /> : null}
                    {position.markAt !== null ? <span className={`nl-track-mark ${rTone}`} style={{ left: `${position.markAt}%` }} /> : null}
                  </span>
                  <span className="nl-track-labels metric-number">
                    <span className="is-down">{position.stop === null ? "No stop" : formatChartPrice(position.stop, position.instrument)}</span>
                    <span className="nl-track-note">
                      <span className="nl-wide-only">{position.progress ?? ""}</span>
                      <span className="nl-narrow-only">
                        {position.mark === null ? "" : formatChartPrice(position.mark, position.instrument)}
                      </span>
                    </span>
                    <span className="is-up">{position.target === null ? "No target" : formatChartPrice(position.target, position.instrument)}</span>
                  </span>
                </span>
                <span className="nl-pos-size metric-number">{position.lots === null ? "—" : `${position.lots.toFixed(2)} lot`}</span>
                <span className={`nl-pos-r metric-number ${rTone}`}>{signedR(position.r)}</span>
                <span className="nl-pos-pl metric-number">
                  <span className={tone(position.money)}>{position.money === null ? "—" : signedMoney(position.money, currency)}</span>
                  {position.spreadCost !== null ? (
                    <small className="nl-pos-spread">Entry spread {signedMoney(-Math.abs(position.spreadCost), currency)}{position.spreadR !== null ? ` · ${signedR(position.spreadR)}` : ""}</small>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </>
      ) : (
        <p className="nl-empty">No open positions. Trades you take show up here.</p>
      )}
    </section>
  );
}

/** "Oct 22 · 9:32 AM → 1:15 PM", or both days when the trade ran overnight. */
function tradeSpan(openedAt: string | null, closedAt: string) {
  if (!openedAt) return `${formatShortDay(closedAt)} · ${formatClockTime(closedAt)}`;
  const openDay = formatShortDay(openedAt);
  const closeDay = formatShortDay(closedAt);
  return openDay === closeDay
    ? `${openDay} · ${formatClockTime(openedAt)} → ${formatClockTime(closedAt)}`
    : `${openDay} ${formatClockTime(openedAt)} → ${closeDay} ${formatClockTime(closedAt)}`;
}

function LedgerActivity({ items, currency }: { items: HomeActivityItem[]; currency: string }) {
  if (!items.length) return null;
  return (
    <section className="nl-sec nl-activity" aria-labelledby="nl-activity-title">
      <div className="nl-sec-head">
        <div className="nl-sec-title">
          <span className="nl-sec-num" aria-hidden="true">03</span>
          <h2 id="nl-activity-title">Recent activity</h2>
        </div>
        <Link href="/journal?tab=closed" className="nl-sec-link">
          View all
          <ArrowUpRight aria-hidden="true" className="nl-wide-only" />
        </Link>
      </div>
      <div className="nl-activity-list">
        {items.slice(0, 6).map((item) => (
          <Link
            key={item.id}
            href={item.instrument ? `/chart?instrument=${item.instrument}${item.chartTradeId ? `&trade=${item.chartTradeId}` : ""}` : "/journal"}
            className="nl-activity-row"
            data-tone={tone(item.paperPl ?? item.resultR)}
          >
            {/* Two groups so phones can stack each side; desktop flattens them into the grid. */}
            <span className="nl-activity-id">
              <b>{item.pair}</b>
              <span className="nl-activity-label">{item.label}</span>
              <span className="nl-activity-time">{tradeSpan(item.openedAt, item.at)}</span>
            </span>
            <span className="nl-activity-result">
              <span className={`metric-number ${tone(item.paperPl)}`}>
                {item.paperPl === null ? "—" : signedMoney(item.paperPl, currency)}
              </span>
              <span className={`metric-number nl-activity-r ${tone(item.resultR, 0.05)}`}>{item.kind === "financing" ? "Interest" :signedR(item.resultR, 1)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- rail */

function LedgerTodayCard({ today, currency }: { today: LedgerToday; currency: string }) {
  const resolved = today.wins + today.losses;
  const winRate = resolved > 0 ? Math.round((today.wins / resolved) * 100) : null;
  const isLoss = today.net !== null && today.net < 0;
  // Bars are sized against the day's biggest trade, 35–100%, so a quiet day
  // still reads as bars rather than slivers.
  const largest = Math.max(...today.results.map((r) => Math.abs(r)), 0.0001);
  return (
    <section className={`nl-today${isLoss ? " is-loss" : ""}`} aria-labelledby="nl-today-title">
      <div className="nl-today-head">
        <h2 id="nl-today-title">Today · closed</h2>
        <span className="metric-number">{today.r === null ? "0.0R" : signedR(today.r, 1)}</span>
      </div>
      <div className="nl-today-main">
        <span className="nl-today-net">{signedMoney(today.net ?? 0, currency)}</span>
        {today.results.length ? (
          <span
            className="nl-today-bars"
            role="img"
            aria-label={`${today.wins} wins and ${today.losses} losses closed today`}
          >
            {today.results.map((r, index) => (
              <span
                key={index}
                className={r >= 0 ? "is-win" : "is-loss"}
                style={{ height: `${35 + 65 * (Math.abs(r) / largest)}%` }}
              />
            ))}
          </span>
        ) : null}
      </div>
      {!today.trades ? <p className="nl-today-empty">No closed trades yet today</p> : null}
      <dl className="nl-today-meta">
        <div>
          <dt>Trades</dt>
          <dd className="metric-number">{today.trades}</dd>
        </div>
        <div>
          <dt>W / L</dt>
          <dd className="metric-number">
            {today.wins}–{today.losses}
          </dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd className="metric-number">{winRate === null ? "—" : `${winRate}%`}</dd>
        </div>
      </dl>
    </section>
  );
}

function LedgerNews({ positions }: { positions: HomeCurrentPosition[] }) {
  const { snapshot: calendar, loading } = useEconomicCalendar();
  const now = useNow(30_000);
  useHomeSectionReady("news", !loading && now !== null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Same-currency releases at the same moment are one row and one sheet.
  const recent = calendar.recentEvents ?? [];
  const preview = now === null ? [] : groupSimultaneousRows(homeCalendarRows(recent, calendar.events, now));
  const allRows = now === null ? [] : groupSimultaneousRows(homeCalendarRows(recent, calendar.events, now, { expanded: true }));
  const rows = expanded ? allRows : preview;
  const canExpand = !loading && calendar.connected && allRows.length > preview.length;
  const openRow = rows.find((row) => row.id === openId) ?? null;
  const openEvent = openRow ? openRow.events[0]! : null;

  return (
    <section className="nl-card nl-news" aria-labelledby="nl-news-title">
      <div className="nl-card-head">
        <h2 id="nl-news-title">Upcoming news</h2>
        <div className="nl-news-actions">
          <span className="nl-card-meta metric-number">ET</span>
          {canExpand ? (
            <button type="button" className="nl-news-more pressable" aria-expanded={expanded} aria-controls={rows.length ? "nl-home-news-list" : undefined} onClick={() => setExpanded((open) => !open)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      </div>
      {loading || now === null ? (
        <p className="nl-card-empty">Loading calendar…</p>
      ) : !calendar.connected ? (
        <p className="nl-card-empty is-warn">Calendar unavailable — verify news manually.</p>
      ) : rows.length ? (
        <div className="nl-news-list" id="nl-home-news-list">
          {rows.map((event) => {
            const impact = homeCalendarImpactTier(event.impact);
            const status = event.state === "live" ? "Now" : event.state === "released" ? "Released" : countdown(event.timestamp, now);
            return (
              <button
                key={event.id}
                type="button"
                className={`nl-news-row is-${event.state}`}
                onClick={() => setOpenId(event.id)}
                aria-label={`${event.currency} ${groupedCalendarTitle(event.events)}, ${status}, ${impact} impact: see how it affects ${event.currency} pairs`}
              >
                <span className="nl-news-when metric-number">
                  <span>{etDay.format(new Date(event.timestamp)).toUpperCase()}</span>
                  <b>{formatClockTime(event.timestamp)}</b>
                </span>
                <span className="nl-news-copy">
                  <b>
                    {event.currency} · {groupedCalendarTitle(event.events)}
                  </b>
                  <span>{status}</span>
                </span>
                <span className={`nl-impact is-${impact}`}>{impact === "high" ? "HIGH" : "MED"}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="nl-card-empty">{homeCalendarEmptyMessage(calendar, now)}</p>
      )}
      <NewsImpactSheet event={openEvent} related={openRow ? openRow.events.slice(1) : []} positions={positions} onClose={() => setOpenId(null)} now={now ?? 0} />
    </section>
  );
}

/**
 * The order's size: the units resting at OANDA ("2.43 lot"), else the size
 * chosen on the ticket before it reaches the broker ("1% risk" for a scheduled
 * % order, whose lots are only worked out when it is placed).
 */
function pendingSizeLabel(entry: PendingManualEntry): string | null {
  const meta = entry.metadata as { units?: unknown; sizeChoice?: { mode?: string; lots?: number; percent?: number } };
  const units = Number(meta.units);
  if (Number.isFinite(units) && units > 0) return `${(Math.abs(units) / 100_000).toFixed(2)} lot`;
  if (meta.sizeChoice?.mode === "lots" && typeof meta.sizeChoice.lots === "number") return `${meta.sizeChoice.lots.toFixed(2)} lot`;
  if (meta.sizeChoice?.mode === "percent" && typeof meta.sizeChoice.percent === "number") return `${meta.sizeChoice.percent}% risk`;
  return null;
}

export function LedgerPending({
  entries,
  cancellingId,
  error,
  onCancel,
  onEdit,
}: {
  entries: PendingManualEntry[];
  cancellingId: string | null;
  error: string | null;
  onCancel: (entry: PendingManualEntry) => void;
  onEdit: (entry: PendingManualEntry) => void;
}) {
  return (
    <section className="nl-card nl-pending" aria-labelledby="nl-pending-title">
      <div className="nl-card-head">
        <h2 id="nl-pending-title">Pending</h2>
        <span className="nl-card-meta metric-number">
          {entries.length} {entries.length === 1 ? "order" : "orders"}
        </span>
      </div>
      {entries.length ? (
        entries.map((entry) => {
          const level = (price: number | null) => pendingLevelPrice(price, entry.instrument).text;
          const note = pendingTimingNote(entry);
          const canCancel = entry.status === "PENDING";
          const isNews = entry.metadata.mode === "news";
          const isNewsV3 = isNews && entry.metadata.configVersion === 3;
          const newsRun = isNewsV3 ? entry.metadata.newsRun as PublicNewsRun | undefined : undefined;
          const stopPips = newsRun?.risk?.stopPips;
          const automaticStop = isNewsV3 && (entry.stopPrice === null || !Number.isFinite(entry.stopPrice));
          const stopText = automaticStop
            ? typeof stopPips === "number" && Number.isFinite(stopPips) && stopPips > 0
              ? `${stopPips.toFixed(1)} pips`
              : "Checking distance"
            : level(entry.stopPrice);
          return (
            <div key={entry.id} className="nl-pending-entry">
              {/* The whole row opens the chart (the link stretches over it);
                  Edit SL/TP and Cancel sit above that layer. */}
              <Link
                href={`/chart?instrument=${entry.instrument}`}
                className="nl-pending-top"
                aria-label={`Open the ${displayNameFor(entry.instrument)} chart`}
              >
                <b>{displayNameFor(entry.instrument)}</b>
                <SideChip direction={entry.direction}>{ORDER_TYPE_LABEL[entry.entryOrderType]}{pendingSizeLabel(entry) ? ` · ${pendingSizeLabel(entry)}` : ""}</SideChip>
                <span className="nl-pending-open" aria-hidden="true">Open chart<ArrowUpRight /></span>
              </Link>
              <dl className="nl-levels">
                <div>
                  <dt>Entry</dt>
                  <dd className="metric-number">{level(entry.entryPrice)}</dd>
                </div>
                <div>
                  <dt>{automaticStop ? "Auto stop · −1R" : "Stop"}</dt>
                  <dd className={`metric-number${!automaticStop && entry.stopPrice === null ? " is-unset" : " is-down"}`} title={automaticStop ? "Planned stop distance. The final stop price is based on the actual fill." : undefined}>{stopText}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd className={`metric-number${isNewsV3 || entry.targetPrice === null ? " is-unset" : " is-up"}`}>{isNewsV3 ? "No fixed target" : level(entry.targetPrice)}</dd>
                </div>
              </dl>
              <div className="nl-pending-foot">
                <span>{note ?? pendingStatusLabel(entry.status)}</span>
                <span className="nl-pending-actions">
                  {!isNews ? <button
                    type="button"
                    className="nl-ghost-btn pressable"
                    disabled={!canCancel || cancellingId === entry.id}
                    onClick={() => onEdit(entry)}
                    aria-label={`Edit stop loss and take profit for ${displayNameFor(entry.instrument)}`}
                  >
                    Edit SL/TP
                  </button> : null}
                  <button
                    type="button"
                    className="nl-ghost-btn pressable"
                    disabled={!canCancel || cancellingId === entry.id}
                    onClick={() => onCancel(entry)}
                    aria-label={`Cancel waiting order for ${displayNameFor(entry.instrument)}`}
                  >
                    {cancellingId === entry.id ? "Cancelling…" : canCancel ? "Cancel" : "Processing"}
                  </button>
                </span>
              </div>
            </div>
          );
        })
      ) : (
        <p className="nl-card-empty">Nothing waiting — orders you set on the chart show up here.</p>
      )}
      {error ? (
        <p className="nl-card-empty is-warn" role="status">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------- page */

export function LedgerHome({
  account,
  accountError,
  history,
  todayKey,
  openPL,
  financialUpdatedAt,
  greeting,
  positions,
  closeAllCount = 0,
  onCloseAll,
  newsPositions,
  today,
  pending,
  cancellingPendingId,
  pendingError,
  onCancelPending,
  onEditPending,
  activity,
  error,
  loadState = READY,
}: {
  account: AccountSummary | null;
  accountError: string | null;
  history: AccountBalanceHistoryPoint[];
  todayKey: string;
  openPL: number;
  financialUpdatedAt?: string | null;
  greeting: string;
  positions: LedgerPosition[];
  closeAllCount?: number;
  onCloseAll?: () => void;
  newsPositions: HomeCurrentPosition[];
  today: LedgerToday;
  pending: PendingManualEntry[];
  cancellingPendingId: string | null;
  pendingError: string | null;
  onCancelPending: (entry: PendingManualEntry) => void;
  onEditPending: (entry: PendingManualEntry) => void;
  activity: HomeActivityItem[];
  error: string | null;
  loadState?: DashboardLoadState;
}) {
  const positionsReady = hasData(loadState.positions) && hasData(loadState.journal);
  const positionState = loadState.positions === "error" || loadState.journal === "error" ? "error" : "loading";
  // todayKey is the server's ET date, so this label matches on both renders.
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${todayKey}T12:00:00Z`));

  return (
    <div className="nl-home">
      <LedgerHeader dateLabel={dateLabel} greeting={greeting} />
      <div className="nl-home-body">
        <LedgerMobileHeader greeting={greeting} />
        {accountError ? (
          <ServiceNotice
            className="account-data-notice"
            title="OANDA connection unavailable"
            description={account
              ? "Showing the last synchronized account and position values. They may be outdated."
              : "Your balance will appear when the connection is restored."}
          />
        ) : null}
        {account ? (
          <LedgerHero account={account} history={history} todayKey={todayKey} openPL={openPL} historyState={loadState.history} financialUpdatedAt={financialUpdatedAt} />
        ) : (
          <section className="nl-hero" aria-label="Account overview">
            <div className="nl-hero-copy">
              <h1 className="nl-home-hello" role="status">{loadState.account === "loading" ? "Loading account…" : "Balance unavailable"}</h1>
            </div>
          </section>
        )}
        {error ? <p className="nl-card-empty is-warn">{error}</p> : null}
        <div className="nl-home-cols">
          <div className="nl-home-main">
            {positionsReady ? <LedgerPositions positions={positions} currency={account?.currency ?? "USD"} closeAllCount={closeAllCount} onCloseAll={onCloseAll} /> : <DeferredCard title="Open positions" state={positionState} />}
            {hasData(loadState.pending) ? <LedgerPending
              entries={pending}
              cancellingId={cancellingPendingId}
              error={pendingError}
              onCancel={onCancelPending}
              onEdit={onEditPending}
            /> : <DeferredCard title="Waiting orders" state={loadState.pending} />}
            {hasData(loadState.journal) ? <LedgerActivity items={activity} currency={account?.currency ?? "USD"} /> : <DeferredCard title="Recent activity" state={loadState.journal} />}
          </div>
          <aside className="nl-home-aside" aria-label="Today and upcoming">
            {hasData(loadState.journal) ? <LedgerTodayCard today={today} currency={account?.currency ?? "USD"} /> : <DeferredCard title="Today · closed" state={loadState.journal} />}
            <LedgerNews positions={newsPositions} />
          </aside>
          <WeeklyReview currency={account?.currency ?? "USD"} />
        </div>
      </div>
    </div>
  );
}
