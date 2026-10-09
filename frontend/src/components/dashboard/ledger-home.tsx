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
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  AccountAmountChart,
  AccountRangeControl,
  buildAccountAmountSeries,
  type AccountChartRange,
} from "@/components/dashboard/account-amount-chart";
import { NewsImpactSheet } from "@/components/dashboard/news-impact-sheet";
import { MorningMarketPicks } from "@/components/dashboard/morning-market-picks";
import type { MorningPicksSnapshot } from "@/lib/strategy/morning-scan";
import { RelativeTime } from "@/components/dashboard/relative-time";
import type { HomeCurrentPosition } from "@/components/dashboard/home-rail";
import { TopPairSearch } from "@/components/layout/top-pair-search";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatEtClock, formatShortDay, tradingDayKey } from "@/lib/format/datetime";
import type { HomeActivityItem } from "@/lib/home/idle";
import { displayNameFor } from "@/lib/instruments/catalog";
import { homeCalendarImpactTier, homeCalendarRows } from "@/lib/news/home-calendar";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import { pendingLevelPrice, pendingStatusLabel, pendingTimingNote } from "@/lib/pending-entry/plain-language";
import { getMarketCondition } from "@/lib/strategy/session";
import { useScrolledPast } from "@/lib/use-scrolled-past";
import type { AccountBalanceHistoryPoint, AccountSummary } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

/* ------------------------------------------------------------------ types */

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
};

export type LedgerSetup = {
  id: string;
  href: string;
  instrument: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
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
const etTime = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" });

const ORDER_TYPE_LABEL: Record<PendingManualEntry["entryOrderType"], string> = {
  buy_limit: "Buy limit",
  buy_stop: "Buy stop",
  sell_limit: "Sell limit",
  sell_stop: "Sell stop",
};

/** A wall clock that only exists after mount, so SSR and hydration agree. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
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
  return { open: condition.marketOpen, label, clock: formatEtClock(now) };
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
  openRisk,
}: {
  account: AccountSummary;
  history: AccountBalanceHistoryPoint[];
  todayKey: string;
  openPL: number;
  openRisk: number | null;
}) {
  const [range, setRange] = useState<AccountChartRange>("1d");
  const wide = useWide();
  const { ref: balanceRef, scrolledPast } = useScrolledPast<HTMLHeadingElement>();
  const series = useMemo(
    () => buildAccountAmountSeries({ nav: account.nav, unrealizedPL: account.unrealizedPL, history, range }),
    [account.nav, account.unrealizedPL, history, range],
  );
  // Same definition as before the redesign: broker balance movements booked
  // this ET day plus what is still floating on open positions.
  const realizedPL = useMemo(
    () => history.reduce((sum, point) => (tradingDayKey(point.time) === todayKey ? sum + point.change : sum), 0),
    [history, todayKey],
  );
  const dayPL = realizedPL + account.unrealizedPL;
  const opening = account.nav - dayPL;
  const changePercent = opening !== 0 ? (dayPL / opening) * 100 : 0;
  const dayTone = tone(dayPL);
  const [dollars, cents] = splitMoney(account.nav, account.currency);
  const percentLabel = `${changePercent >= 0 ? "+" : "−"}${Math.abs(changePercent).toFixed(2)}%`;
  const marginShare = account.nav > 0 ? (account.marginUsed / account.nav) * 100 : null;
  const riskShare = openRisk !== null && account.nav > 0 ? (openRisk / account.nav) * 100 : null;

  return (
    <section className="nl-hero" aria-label="Account overview">
      {/* Phone: the balance stays pinned once the hero scrolls away. */}
      <div className={`nl-mbar${scrolledPast ? " is-visible" : ""}`} aria-hidden={!scrolledPast}>
        <span className="nl-mbar-balance">{money(account.nav, account.currency)}</span>
        <div className="nl-mbar-actions">
          <span className={`nl-chip ${dayTone}`}>{percentLabel}</span>
          <NotificationBell compact className="nl-bell nl-mbar-bell" />
        </div>
      </div>

      <div className="nl-hero-copy">
        <span className="nl-overline">Total balance</span>
        <h1 ref={balanceRef} className="nl-hero-balance">
          {dollars}
          <span className="nl-hero-cents">{cents}</span>
        </h1>
        <div className="nl-hero-change">
          <span className={`nl-chip ${dayTone}`}>
            {dayTone !== "is-flat" ? <ArrowUpRight className={`nl-chip-arrow ${dayTone}`} aria-hidden="true" /> : null}
            {signedMoney(dayPL, account.currency)}
          </span>
          <span className={`nl-hero-pct metric-number ${dayTone}`}>{percentLabel} today</span>
          <span className="nl-hero-open">from {money(opening, account.currency)} at the open</span>
        </div>
      </div>

      <AccountRangeControl range={range} onRangeChange={setRange} className="nl-range-tabs" />

      <div className="nl-chart-card">
        <AccountAmountChart
          series={series}
          currency={account.currency}
          range={range}
          onRangeChange={setRange}
          hideRangeRow
          variant="ledger"
          scales={wide}
        />
      </div>

      <dl className="nl-stats">
        <div>
          <dt>Realized today</dt>
          <dd className={`metric-number ${tone(realizedPL)}`}>{signedMoney(realizedPL, account.currency)}</dd>
        </div>
        <div>
          <dt>Unrealized</dt>
          <dd className={`metric-number ${tone(openPL)}`}>{signedMoney(openPL, account.currency)}</dd>
        </div>
        <div>
          <dt>
            Open risk{riskShare !== null ? <span> · {riskShare.toFixed(1)}%<span className="nl-wide-only"> of balance</span></span> : null}
          </dt>
          <dd className="metric-number">{openRisk === null ? "—" : money(openRisk, account.currency)}</dd>
        </div>
        <div>
          <dt>
            Margin<span className="nl-wide-only"> used</span>
            {marginShare !== null ? <span> · {marginShare.toFixed(1)}%</span> : null}
          </dt>
          <dd className="nl-stat-margin">
            <span className="metric-number">{money(account.marginUsed, account.currency)}</span>
            {marginShare !== null ? (
              <span className="nl-meter nl-wide-only" aria-hidden="true">
                <span style={{ width: `${Math.min(100, marginShare)}%` }} />
              </span>
            ) : null}
          </dd>
        </div>
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

function LedgerPositions({ positions, currency }: { positions: LedgerPosition[]; currency: string }) {
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
        <Link href="/journal" className="nl-sec-link">
          <span className="nl-wide-only">Journal</span>
          <span className="nl-narrow-only">See all</span>
          <ArrowUpRight aria-hidden="true" className="nl-wide-only" />
        </Link>
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
                    <span className="is-down">{position.stop === null ? "—" : formatChartPrice(position.stop, position.instrument)}</span>
                    <span className="nl-track-note">
                      <span className="nl-wide-only">{position.progress ?? ""}</span>
                      <span className="nl-narrow-only">
                        {position.mark === null ? "" : formatChartPrice(position.mark, position.instrument)}
                      </span>
                    </span>
                    <span className="is-up">{position.target === null ? "—" : formatChartPrice(position.target, position.instrument)}</span>
                  </span>
                </span>
                <span className="nl-pos-size metric-number">{position.lots === null ? "—" : `${position.lots.toFixed(2)} lot`}</span>
                <span className={`nl-pos-r metric-number ${rTone}`}>{signedR(position.r)}</span>
                <span className={`nl-pos-pl metric-number ${tone(position.money)}`}>
                  {position.money === null ? "Open" : signedMoney(position.money, currency)}
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

function LedgerSetups({ setups }: { setups: LedgerSetup[] }) {
  if (!setups.length) return null;
  return (
    <section className="nl-sec nl-setups" aria-labelledby="nl-setups-title">
      <SectionHead number="02" title="Saved setups" id="nl-setups-title" />
      <div className="nl-setup-grid">
        {setups.map((setup) => (
          <Link key={setup.id} href={setup.href} className="nl-setup">
            <span className="nl-setup-top">
              <b>{displayNameFor(setup.instrument)}</b>
              <span className="nl-setup-time metric-number">
                <RelativeTime at={setup.decisionTime} />
              </span>
            </span>
            <SideChip direction={setup.direction}>{setup.direction === "long" ? "Buy" : "Sell"}</SideChip>
            <dl className="nl-levels">
              <div>
                <dt>Entry</dt>
                <dd className="metric-number">{formatChartPrice(setup.entry, setup.instrument)}</dd>
              </div>
              <div>
                <dt>Stop</dt>
                <dd className="metric-number is-down">{formatChartPrice(setup.stop, setup.instrument)}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd className="metric-number is-up">{formatChartPrice(setup.target, setup.instrument)}</dd>
              </div>
            </dl>
          </Link>
        ))}
      </div>
    </section>
  );
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
          >
            <b>{item.pair}</b>
            <span className="nl-activity-label">{item.label}</span>
            <span className={`metric-number ${tone(item.paperPl)}`}>
              {item.paperPl === null ? "—" : signedMoney(item.paperPl, currency)}
            </span>
            <span className={`metric-number ${tone(item.resultR, 0.05)}`}>{signedR(item.resultR, 1)}</span>
            <span className="nl-activity-time">{formatShortDay(item.at)}</span>
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
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = now === null ? [] : homeCalendarRows(calendar.recentEvents ?? [], calendar.events, now);
  const openEvent = rows.find((row) => row.id === openId) ?? null;

  return (
    <section className="nl-card nl-news" aria-labelledby="nl-news-title">
      <div className="nl-card-head">
        <h2 id="nl-news-title">Upcoming news</h2>
        <span className="nl-card-meta metric-number">ET</span>
      </div>
      {loading || now === null ? (
        <p className="nl-card-empty">Loading calendar…</p>
      ) : !calendar.connected ? (
        <p className="nl-card-empty is-warn">Calendar unavailable — verify news manually.</p>
      ) : rows.length ? (
        <div className="nl-news-list">
          {rows.map((event) => {
            const high = homeCalendarImpactTier(event.impact) === "high";
            const status = event.state === "live" ? "Now" : event.state === "released" ? "Released" : countdown(event.timestamp, now);
            return (
              <button
                key={event.id}
                type="button"
                className={`nl-news-row is-${event.state}`}
                onClick={() => setOpenId(event.id)}
                aria-label={`${event.currency} ${event.title}, ${status}, ${high ? "high" : "medium"} impact: see how it affects ${event.currency} pairs`}
              >
                <span className="nl-news-when metric-number">
                  <span>{etDay.format(new Date(event.timestamp)).toUpperCase()}</span>
                  <b>{etTime.format(new Date(event.timestamp))}</b>
                </span>
                <span className="nl-news-copy">
                  <b>
                    {event.currency} · {event.title}
                  </b>
                  <span>{status}</span>
                </span>
                <span className={`nl-impact ${high ? "is-high" : "is-medium"}`}>{high ? "HIGH" : "MED"}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="nl-card-empty">{calendar.warnings[0]?.tone !== "success" && calendar.warnings[0]?.message ? calendar.warnings[0].message : "No high or medium impact events this week."}</p>
      )}
      <NewsImpactSheet event={openEvent} positions={positions} onClose={() => setOpenId(null)} now={now ?? 0} />
    </section>
  );
}

function LedgerPending({
  entries,
  cancellingId,
  error,
  onCancel,
}: {
  entries: PendingManualEntry[];
  cancellingId: string | null;
  error: string | null;
  onCancel: (entry: PendingManualEntry) => void;
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
          return (
            <div key={entry.id} className="nl-pending-entry">
              <Link href={`/chart?instrument=${entry.instrument}`} className="nl-pending-top">
                <b>{displayNameFor(entry.instrument)}</b>
                <SideChip direction={entry.direction}>{ORDER_TYPE_LABEL[entry.entryOrderType]}</SideChip>
              </Link>
              <dl className="nl-levels">
                <div>
                  <dt>Entry</dt>
                  <dd className="metric-number">{level(entry.entryPrice)}</dd>
                </div>
                <div>
                  <dt>Stop</dt>
                  <dd className="metric-number is-down">{level(entry.stopPrice)}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd className="metric-number is-up">{level(entry.targetPrice)}</dd>
                </div>
              </dl>
              <div className="nl-pending-foot">
                <span>{note ?? pendingStatusLabel(entry.status)}</span>
                <button
                  type="button"
                  className="nl-ghost-btn pressable"
                  disabled={!canCancel || cancellingId === entry.id}
                  onClick={() => onCancel(entry)}
                  aria-label={`Cancel waiting order for ${displayNameFor(entry.instrument)}`}
                >
                  {cancellingId === entry.id ? "Cancelling…" : canCancel ? "Cancel" : "Processing"}
                </button>
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
  morningPicks,
  account,
  history,
  todayKey,
  openPL,
  openRisk,
  greeting,
  positions,
  setups,
  newsPositions,
  today,
  pending,
  cancellingPendingId,
  pendingError,
  onCancelPending,
  activity,
  error,
}: {
  morningPicks: MorningPicksSnapshot | null;
  account: AccountSummary;
  history: AccountBalanceHistoryPoint[];
  todayKey: string;
  openPL: number;
  openRisk: number | null;
  greeting: string;
  positions: LedgerPosition[];
  setups: LedgerSetup[];
  newsPositions: HomeCurrentPosition[];
  today: LedgerToday;
  pending: PendingManualEntry[];
  cancellingPendingId: string | null;
  pendingError: string | null;
  onCancelPending: (entry: PendingManualEntry) => void;
  activity: HomeActivityItem[];
  error: string | null;
}) {
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
        <LedgerHero account={account} history={history} todayKey={todayKey} openPL={openPL} openRisk={openRisk} />
        {error ? <p className="nl-card-empty is-warn">{error}</p> : null}
        <div className="nl-home-cols">
          <div className="nl-home-main">
            <MorningMarketPicks initial={morningPicks} />
            <LedgerPositions positions={positions} currency={account.currency} />
            <LedgerSetups setups={setups} />
            <LedgerPending
              entries={pending}
              cancellingId={cancellingPendingId}
              error={pendingError}
              onCancel={onCancelPending}
            />
            <LedgerActivity items={activity} currency={account.currency} />
          </div>
          <aside className="nl-home-aside" aria-label="Today and upcoming">
            <LedgerTodayCard today={today} currency={account.currency} />
            <LedgerNews positions={newsPositions} />
          </aside>
        </div>
      </div>
    </div>
  );
}
