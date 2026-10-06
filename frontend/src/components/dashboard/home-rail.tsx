"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  homeCalendarImpactTier,
  homeCalendarMoveSize,
  homeCalendarRows,
} from "@/lib/news/home-calendar";
import { NewsImpactSheet } from "@/components/dashboard/news-impact-sheet";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import type { MajorInstrument } from "@/types/forex";

export type HomeAvailableSignal = {
  kind: "setup";
  id: string;
  instrument: MajorInstrument;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  evaluatedAt: string | null;
};

export type HomeCurrentPosition = {
  kind: "position";
  id: string;
  instrument: MajorInstrument;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  openedAt: string;
};

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function eventTime(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(timestamp));
}

function eventDay(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(timestamp));
}

export function HomeRail({
  currentPositions,
  currency,
  todayNet,
  todayR,
  todayTrades,
  todayWins,
  todayLosses,
}: {
  /** Unused since the Markets card was removed; kept so callers need no change. */
  quotes: Record<string, { bid: number; ask: number }>;
  /** Saved, immutable plans. These are never synthesized from a live quote. */
  availableSignals: HomeAvailableSignal[];
  /** Open paper trades take priority over prospective setups in this rail. */
  currentPositions: HomeCurrentPosition[];
  currency: string;
  /** Realized money booked today; null when nothing has closed. */
  todayNet: number | null;
  todayR: number | null;
  todayTrades: number;
  todayWins: number;
  todayLosses: number;
}) {
  const { snapshot: calendar, loading: calendarLoading } = useEconomicCalendar();
  const resolvedToday = todayWins + todayLosses;
  const winPercent = resolvedToday > 0 ? Math.round((todayWins / resolvedToday) * 100) : null;
  const hasTodayTrades = todayTrades > 0;
  const netPositive = (todayNet ?? 0) >= 0;
  const todayIsLoss = todayNet !== null && todayNet < 0;
  const rPositive = (todayR ?? 0) >= 0;
  // Ticks so rows go live, grey out and roll over at midnight without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const upcomingNews = homeCalendarRows(calendar.recentEvents ?? [], calendar.events, now);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const openEvent = upcomingNews.find((event) => event.id === openEventId) ?? null;

  return (
    <aside className="home-rail" aria-label="Today and upcoming news">
      <section
        className={`home-rail-section home-rail-total${todayIsLoss ? " is-loss" : ""}`}
        aria-label="Today"
      >
        <div className="home-rail-heading">
          <span>Today</span>
        </div>
        <div className="home-rail-total-row">
          <p className={`home-rail-total-lead ${netPositive ? "is-positive" : "is-negative"}`}>
            {todayNet === null
              ? money(0, currency)
              : `${netPositive ? "+" : "−"}${money(Math.abs(todayNet), currency)}`}
          </p>
          <p className={`home-rail-total-r ${rPositive ? "is-positive" : "is-negative"}`}>
            {todayR === null ? "0.0R" : `${todayR > 0 ? "+" : ""}${todayR.toFixed(1)}R`}
          </p>
        </div>
        {!hasTodayTrades ? <p className="home-rail-total-empty">No closed trades today</p> : null}
        <dl className="home-rail-total-meta">
          <div>
            <dt>Trades</dt>
            <dd>{todayTrades}</dd>
          </div>
          <div>
            <dt>W/L</dt>
            <dd>
              {todayWins}/{todayLosses}
            </dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{winPercent === null ? "0%" : `${winPercent}%`}</dd>
          </div>
        </dl>
        <div className="home-rail-bar" aria-hidden="true">
          <span className={todayIsLoss ? "is-loss" : "is-win"} />
        </div>
      </section>

      <section className="home-rail-section home-rail-news" aria-label="Current and upcoming high and medium impact news">
        <div className="home-rail-heading">
          <span>High &amp; medium news</span>
          <a
            href="https://www.forexfactory.com/calendar"
            target="_blank"
            rel="noreferrer"
            className="home-rail-news-source"
            aria-label="Open Forex Factory calendar"
          >
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
        {calendarLoading ? (
          <p className="home-rail-news-empty">Loading calendar…</p>
        ) : !calendar.connected ? (
          <p className="home-rail-news-empty is-unavailable">Calendar unavailable — verify news manually.</p>
        ) : upcomingNews.length ? (
          <div className="home-rail-news-list">
            {upcomingNews.map((event) => {
              const tier = homeCalendarImpactTier(event.impact);
              const moveSize = homeCalendarMoveSize(event);
              return (
                <div
                  role="button"
                  tabIndex={0}
                  key={event.id}
                  className={`home-rail-news-event is-${tier}-impact is-${event.state}`}
                  onClick={() => setOpenEventId(event.id)}
                  onKeyDown={(keyEvent) => {
                    if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                      keyEvent.preventDefault();
                      setOpenEventId(event.id);
                    }
                  }}
                  aria-label={`${event.title}${event.state === "live" ? " (released, happening now)" : event.state === "released" ? " (released today)" : ""}: see how it affects ${event.currency} pairs`}
                >
                  <time className="metric-number" dateTime={event.timestamp}>
                    <span>{eventTime(event.timestamp)}</span>
                    <span className="home-rail-news-day">{eventDay(event.timestamp)}</span>
                  </time>
                  <span className="home-rail-news-tags">
                    <span className="home-rail-news-currency">{event.currency}</span>
                    {event.state === "live" ? <span className="home-rail-news-live">Now</span>
                      : event.state === "released" ? <span className="home-rail-news-released">Released</span> : null}
                  </span>
                  <div className="home-rail-news-copy">
                    <p>{event.title}</p>
                    <p className={`home-rail-news-size is-${moveSize}`}>
                      {moveSize === "massive"
                        ? "Massive impact"
                        : moveSize === "high"
                          ? "High impact"
                          : "Moderate impact"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : calendar.warnings[0]?.tone !== "success" ? (
          <p className={`home-rail-news-empty ${calendar.warnings[0]?.tone === "danger" ? "is-unavailable" : ""}`}>
            {calendar.warnings[0]?.message}
          </p>
        ) : (
          <p className="home-rail-news-empty">No high or medium impact events in this week’s feed.</p>
        )}
      </section>
      <NewsImpactSheet
        event={openEvent}
        positions={currentPositions}
        onClose={() => setOpenEventId(null)}
        now={now}
      />
    </aside>
  );
}
