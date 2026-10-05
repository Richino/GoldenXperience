"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import {
  homeCalendarImpactTier,
  homeCalendarMoveSize,
  upcomingHomeCalendarEvents,
} from "@/lib/news/home-calendar";
import { NewsImpactSheet } from "@/components/dashboard/news-impact-sheet";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import type { CandleSeries, MajorInstrument } from "@/types/forex";

const MARKET_PAIRS: MajorInstrument[] = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "AUD_USD",
  "USD_CAD",
];

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

function compactPair(instrument: string) {
  return displayNameFor(instrument);
}

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
  quotes,
  currentPositions,
  currency,
  todayNet,
  todayR,
  todayTrades,
  todayWins,
  todayLosses,
}: {
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
  const [dayChange, setDayChange] = useState<Record<string, number>>({});
  const [lastClose, setLastClose] = useState<Record<string, number>>({});
  const { snapshot: calendar, loading: calendarLoading } = useEconomicCalendar();
  const resolvedToday = todayWins + todayLosses;
  const winPercent = resolvedToday > 0 ? Math.round((todayWins / resolvedToday) * 100) : null;
  const hasTodayTrades = todayTrades > 0;
  const netPositive = (todayNet ?? 0) >= 0;
  const todayIsLoss = todayNet !== null && todayNet < 0;
  const rPositive = (todayR ?? 0) >= 0;
  const upcomingNews = upcomingHomeCalendarEvents(calendar.events);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const openEvent = upcomingNews.find((event) => event.id === openEventId) ?? null;

  useEffect(() => {
    let cancelled = false;

    async function loadChanges() {
      const entries = await Promise.all(
        MARKET_PAIRS.map(async (instrument) => {
          try {
            const response = await fetch(
              apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=D&count=3`),
              { credentials: "include", cache: "no-store" },
            );
            if (!response.ok) return { instrument, change: null, close: null };
            const payload = (await response.json()) as { data?: CandleSeries };
            const candles = payload.data?.candles ?? [];
            const previous = candles.at(-2)?.close;
            const latest = candles.at(-1)?.close;
            if (!previous || !latest) return { instrument, change: null, close: latest ?? null };
            return {
              instrument,
              change: ((latest - previous) / previous) * 100,
              close: latest,
            };
          } catch {
            return { instrument, change: null, close: null };
          }
        }),
      );

      if (cancelled) return;
      const nextChange: Record<string, number> = {};
      const nextClose: Record<string, number> = {};
      for (const entry of entries) {
        if (entry.change !== null) nextChange[entry.instrument] = entry.change;
        if (entry.close !== null) nextClose[entry.instrument] = entry.close;
      }
      setDayChange(nextChange);
      setLastClose(nextClose);
    }

    void loadChanges();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="home-rail" aria-label="Current positions, available signals, and markets">
      <section className="home-rail-section home-rail-markets-section">
        <div className="home-rail-heading">
          <span>Markets</span>
          <Link href="/watchlist" className="home-rail-link">
            See all
          </Link>
        </div>
        <div className="home-rail-markets">
          {MARKET_PAIRS.map((instrument) => {
            const quote = quotes[instrument];
            const mid = quote
              ? (quote.bid + quote.ask) / 2
              : lastClose[instrument] ?? null;
            const change = dayChange[instrument];
            const flat = change !== undefined && Math.abs(change) < 0.005;
            const positive = (change ?? 0) >= 0;
            return (
              <Link
                key={instrument}
                href={`/chart?instrument=${instrument}`}
                className="home-rail-market"
              >
                <span>{compactPair(instrument)}</span>
                <span className="metric-number">
                  {mid === null ? "—" : formatChartPrice(mid, instrument)}
                </span>
                <span
                  className={
                    change === undefined || flat
                      ? "is-neutral"
                      : positive
                        ? "is-positive"
                        : "is-negative"
                  }
                >
                  {change === undefined
                    ? "—"
                    : `${positive ? "+" : ""}${change.toFixed(2)}%`}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

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

      <section className="home-rail-section home-rail-news" aria-label="Upcoming high and medium impact news">
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
                  className={`home-rail-news-event is-${tier}-impact`}
                  onClick={() => setOpenEventId(event.id)}
                  onKeyDown={(keyEvent) => {
                    if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                      keyEvent.preventDefault();
                      setOpenEventId(event.id);
                    }
                  }}
                  aria-label={`${event.title}: see how it affects ${event.currency} pairs`}
                >
                  <time className="metric-number" dateTime={event.timestamp}>
                    <span>{eventTime(event.timestamp)}</span>
                    <span className="home-rail-news-day">{eventDay(event.timestamp)}</span>
                  </time>
                  <span className="home-rail-news-currency">{event.currency}</span>
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
      />
    </aside>
  );
}
