"use client";

/**
 * The workstation Chart page's readouts (canvas "Chart · Desktop"): header
 * facts and session, the chart legend, the inspector's position, health and
 * watchlist sections, and the status bar. Facts, legend and status are worked
 * out from data the page already holds; the watchlist reads live quotes and
 * today's move from the same cache as Markets.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CHART_INDICATORS, CHART_TIMEFRAME_LABELS, formatChartPrice, type ChartIndicator, type ChartTimeframe } from "@/lib/chart-utils";
import { TrendLabel } from "@/components/charts/trend-label";
import { formatEtClock } from "@/lib/format/datetime";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { marketDailyCache } from "@/lib/market-daily";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import type { WatchlistDay } from "@/lib/watchlist-daily-cache";
import {
  getMarketCondition,
  LONDON_TIME_ZONE,
  NEW_YORK_TIME_ZONE,
  sessionHour,
  TOKYO_TIME_ZONE,
} from "@/lib/strategy/session";
import type { Candle, MajorInstrument, PriceQuote } from "@/types/forex";

const DAY_MS = 86_400_000;

const CANDLE_MINUTES: Record<ChartTimeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1_440,
  "1w": 10_080,
};

const INDICATOR_LABELS = new Map<string, string>(CHART_INDICATORS.map((indicator) => [indicator.value, indicator.label]));

/** A clock that only exists after mount, so SSR and hydration agree. */
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

/** High and low of the candles that closed in the last 24 hours on the chart. */
function recentRange(candles: Candle[]) {
  const last = candles.at(-1);
  if (!last) return null;
  const since = Date.parse(last.time) - DAY_MS;
  let high = -Infinity;
  let low = Infinity;
  for (const candle of candles) {
    if (Date.parse(candle.time) < since) continue;
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
  }
  return Number.isFinite(high) ? { high, low } : null;
}

/** Wilder's ATR over the last `period` candles, in pips. */
function averageTrueRangePips(candles: Candle[], instrument: string, period = 14) {
  if (candles.length <= period) return null;
  const recent = candles.slice(-(period + 1));
  let sum = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const { high, low } = recent[index]!;
    const prevClose = recent[index - 1]!.close;
    sum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return sum / period / pipSizeFor(instrument);
}

function useSession(intervalMs = 30_000) {
  const now = useNow(intervalMs);
  if (now === null) return null;
  const condition = getMarketCondition(new Date(now));
  return {
    now,
    open: condition.marketOpen,
    label: condition.marketOpen ? condition.label : "Market closed",
    clock: formatEtClock(now),
  };
}

/* --------------------------------------------------------- session */

const nyWeekday = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, weekday: "short" });
const nyDayAndTime = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, weekday: "short", hour: "numeric", minute: "2-digit" });

const SESSION_NAMES: Record<string, string> = {
  "London / New York": "London + New York",
  London: "London",
  "New York": "New York",
  Asia: "Asia",
  Open: "Between sessions",
};

/** "45m", "2h 18m", "1d 15h". */
function untilLabel(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

/** The next 17:00 New York time on the given weekday (Sun = open, Fri = close). */
function nextWeekBoundary(now: number, weekday: "Sun" | "Fri") {
  const today = now - (now % DAY_MS);
  for (let day = 0; day <= 8; day += 1) {
    const at = sessionHour(today + day * DAY_MS, 17, NEW_YORK_TIME_ZONE);
    if (at > now && nyWeekday.format(at) === weekday) return at;
  }
  return null;
}

/** The soonest London, New York or Tokyo open/close, or the weekly close. */
function nextSessionEvent(now: number) {
  const today = now - (now % DAY_MS);
  const centres = [
    { name: "London", zone: LONDON_TIME_ZONE },
    { name: "New York", zone: NEW_YORK_TIME_ZONE },
    { name: "Tokyo", zone: TOKYO_TIME_ZONE },
  ];
  const events: Array<{ at: number; label: string }> = [];
  for (let day = -1; day <= 2; day += 1) {
    const dayMs = today + day * DAY_MS;
    for (const centre of centres) {
      events.push({ at: sessionHour(dayMs, 8, centre.zone), label: `${centre.name} opens` });
      events.push({ at: sessionHour(dayMs, 17, centre.zone), label: `${centre.name} closes` });
    }
  }
  const weeklyClose = nextWeekBoundary(now, "Fri");
  const upcoming = events.filter((event) => event.at > now).sort((a, b) => a.at - b.at);
  const next = upcoming[0];
  // Nothing past the weekly close happens until the market reopens, and
  // Friday's New York close is that weekly close.
  if (weeklyClose !== null && (!next || next.at >= weeklyClose)) return { at: weeklyClose, label: "Market closes" };
  return next ?? null;
}

/** What the market is doing now and what changes next, for the header. */
function describeSession(now: number) {
  const condition = getMarketCondition(new Date(now));
  if (!condition.marketOpen) {
    const opens = nextWeekBoundary(now, "Sun");
    return {
      tone: "closed" as const,
      label: "Closed",
      next: opens === null ? null : `opens in ${untilLabel(opens - now)}`,
      detail: opens === null ? "Market closed" : `Market closed · opens ${nyDayAndTime.format(opens)} ET, in ${untilLabel(opens - now)}`,
    };
  }
  const event = nextSessionEvent(now);
  const name = SESSION_NAMES[condition.label] ?? condition.label;
  return {
    tone: condition.label === "Asia" || condition.label === "Open" ? ("quiet" as const) : ("active" as const),
    label: name,
    next: event ? `${event.label} in ${untilLabel(event.at - now)}` : null,
    detail: event ? `${name} open · ${event.label} in ${untilLabel(event.at - now)}` : `${name} open`,
  };
}

/** Header readout: the session(s) trading now and what changes next. The full
 * times and the ET clock sit in its tooltip; the sidebar already shows the clock. */
export function ChartSessionPill() {
  const now = useNow(15_000);
  const session = now === null ? null : describeSession(now);
  const clock = now === null ? "— ET" : formatEtClock(now);
  return (
    <span
      className={`nl-csession is-${session?.tone ?? "closed"}`}
      title={session ? `${session.detail} · ${clock}` : undefined}
    >
      <span className="nl-csession-dot" aria-hidden="true" />
      <b>{session?.label ?? "Session"}</b>
      {session?.next ? <span className="nl-csession-next">{session.next}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------- header */

export function ChartHeadFacts({
  instrument,
  quote,
  candles,
  timeframe,
  spreadPips,
  spreadTier,
}: {
  instrument: MajorInstrument;
  quote: PriceQuote | null;
  candles: Candle[];
  timeframe: ChartTimeframe;
  spreadPips: number | null;
  spreadTier: string;
}) {
  const range = useMemo(() => recentRange(candles), [candles]);
  const atr = useMemo(() => averageTrueRangePips(candles, instrument), [candles, instrument]);
  const live = quote?.instrument === instrument ? quote : null;
  const price = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatChartPrice(value, instrument));
  const spreadKnown = spreadPips !== null && Number.isFinite(spreadPips);

  return (
    <dl className="nl-cfacts">
      <div>
        <dt>Bid</dt>
        <dd className="metric-number">{price(live?.bid)}</dd>
      </div>
      <div>
        <dt>Ask</dt>
        <dd className="metric-number">{price(live?.ask)}</dd>
      </div>
      <div>
        <dt>Spread</dt>
        <dd className={`metric-number nl-spread is-${spreadTier}`} aria-label={spreadKnown ? `Spread ${spreadPips.toFixed(1)} pips` : "Spread unavailable"}>
          {spreadKnown ? spreadPips.toFixed(1) : "—"}
        </dd>
      </div>
      <div>
        <dt>Day range</dt>
        <dd className="metric-number">{range ? `${price(range.low)} – ${price(range.high)}` : "—"}</dd>
      </div>
      <div>
        <dt>ATR 14 · <span className="nl-cfacts-tf">{CHART_TIMEFRAME_LABELS[timeframe]}</span></dt>
        <dd className="metric-number">{atr === null ? "—" : `${atr.toFixed(1)} pips`}</dd>
      </div>
    </dl>
  );
}

/* -------------------------------------------------------------- chart */

/**
 * OHLC of the latest candle and a chip per enabled indicator, over the chart.
 * Pair and timeframe already head the page and the toolbar, so it skips them.
 */
export function ChartLegend({
  candles,
  instrument,
  indicators,
}: {
  candles: Candle[];
  instrument: MajorInstrument;
  indicators: ChartIndicator[];
}) {
  const last = candles.at(-1) ?? null;
  const move = last ? last.close - last.open : 0;
  const tone = move >= 0 ? "is-up" : "is-down";
  const pips = last ? Math.abs(move) / pipSizeFor(instrument) : 0;

  return (
    <div className="nl-clegend" aria-hidden="true">
      <div className="nl-clegend-ohlc metric-number">
        {last ? (
          <>
            <span>O <i>{formatChartPrice(last.open, instrument)}</i></span>
            <span>H <i>{formatChartPrice(last.high, instrument)}</i></span>
            <span>L <i>{formatChartPrice(last.low, instrument)}</i></span>
            <span>C <i className={tone}>{formatChartPrice(last.close, instrument)}</i></span>
            <span className={tone}>{move >= 0 ? "+" : "−"}{pips.toFixed(1)} p</span>
          </>
        ) : null}
      </div>
      {indicators.length ? (
        <div className="nl-clegend-chips">
          {indicators.map((indicator) => (
            <span key={indicator} className="nl-clegend-chip">
              <i data-indicator={indicator} />
              {INDICATOR_LABELS.get(indicator) ?? indicator}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- inspector */

/** The 12 pairs the watchlist follows: the seven majors and five crosses, all on the tick stream. */
const WATCHLIST_PAIRS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD",
  "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD",
] as const;

/**
 * Live price (streamed mid, else today's close) and today's change; the open
 * pair is marked. The change is worked out from the live mid against
 * yesterday's close, so it moves with every tick, not once a minute.
 */
export function ChartWatchlistCard({ instrument }: { instrument: string }) {
  const quotes = useLiveQuotes();
  const pairs = WATCHLIST_PAIRS;
  const [days, setDays] = useState<Record<string, WatchlistDay | null>>({});
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      for (const pair of pairs) {
        marketDailyCache.load(pair)
          .then((day) => { if (!cancelled) setDays((previous) => ({ ...previous, [pair]: day })); })
          .catch(() => { if (!cancelled) setDays((previous) => ({ ...previous, [pair]: previous[pair] ?? null })); });
      }
    };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [pairs]);

  return (
    <section className="nl-cside-card nl-cwl" aria-labelledby="nl-cwl-title">
      <div className="nl-cside-head">
        <h2 id="nl-cwl-title">Watchlist</h2>
        <span className="nl-cwl-head-end">
          <Link href="/watchlist" className="nl-cwl-link">Markets →</Link>
        </span>
      </div>
      <div className="nl-cwl-list">
        {pairs.map((pair) => {
          const quote = quotes[pair];
          const day = days[pair];
          const live = quote && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) ? (quote.bid + quote.ask) / 2 : null;
          const price = live ?? day?.close ?? null;
          const previousClose = day?.close != null && day.change != null ? day.close / (1 + day.change / 100) : null;
          const change = live !== null && previousClose ? ((live - previousClose) / previousClose) * 100 : day?.change ?? null;
          return (
            <Link key={pair} href={`/chart?instrument=${pair}`} className={`nl-cwl-row${pair === instrument ? " is-current" : ""}`} aria-current={pair === instrument ? "page" : undefined}>
              <span>{displayNameFor(pair as MajorInstrument)}</span>
              <span className="metric-number">{price === null ? "—" : formatChartPrice(price, pair as MajorInstrument)}</span>
              <span className={`metric-number ${change === null ? "" : change >= 0 ? "is-up" : "is-down"}`}>
                {change === null ? "—" : `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)}%`}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- phone */

/** Phone OHLC line for the latest candle, under the timeframes. */
export function ChartMobileOhlc({ candles, instrument }: { candles: Candle[]; instrument: MajorInstrument }) {
  const last = candles.at(-1) ?? null;
  if (!last) return null;
  const tone = last.close >= last.open ? "is-up" : "is-down";
  return (
    <div className="nl-mohlc metric-number">
      <div className="nl-mohlc-values" aria-label="Latest candle">
        <span>O <i>{formatChartPrice(last.open, instrument)}</i></span>
        <span>H <i>{formatChartPrice(last.high, instrument)}</i></span>
        <span>L <i>{formatChartPrice(last.low, instrument)}</i></span>
        <span>C <i className={tone}>{formatChartPrice(last.close, instrument)}</i></span>
      </div>
      {/* Same weekly + daily read as the pair picker rows. */}
      <TrendLabel instrument={instrument} className="nl-trend-compact nl-mohlc-trend" plainLanguage />
    </div>
  );
}

function heldLabel(openedAt: string | null | undefined, now: number | null) {
  if (!openedAt || now === null) return null;
  const minutes = Math.max(0, Math.round((now - Date.parse(openedAt)) / 60_000));
  if (!Number.isFinite(minutes)) return null;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Where `value` sits between `from` and `to`, 0–100. */
function trackAt(value: number, from: number, to: number) {
  return Math.max(0, Math.min(100, ((value - from) / (to - from)) * 100));
}

/**
 * Phone position strip: side, size / time held, the move and R, and a stop →
 * target track: an open trade's own levels, with the move in pips (the phone
 * has no account P/L here). Nothing shows without one.
 */
export function ChartMobilePosition({
  signal,
  mark,
  instrument,
}: {
  signal: { direction: "long" | "short"; entry: number; stop: number | null; target: number | null; openedAt?: string | null } | null;
  mark: number | null;
  instrument: MajorInstrument;
}) {
  const now = useNow(30_000);
  const at = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatChartPrice(value, instrument));

  if (!signal) return null;

  const sign = signal.direction === "long" ? 1 : -1;
  const pip = pipSizeFor(instrument);
  const movePips = mark === null ? null : ((mark - signal.entry) * sign) / pip;
  const riskPips = signal.stop === null ? null : Math.abs(signal.entry - signal.stop) / pip;
  const r = movePips !== null && riskPips ? movePips / riskPips : null;
  const tone = movePips === null || Math.abs(movePips) < 0.05 ? "" : movePips > 0 ? "is-up" : "is-down";
  const held = heldLabel(signal.openedAt, now);
  const hasTrack = signal.stop !== null && signal.target !== null && signal.stop !== signal.target;
  const entryAt = hasTrack ? trackAt(signal.entry, signal.stop!, signal.target!) : 0;
  const markAt = hasTrack && mark !== null ? trackAt(mark, signal.stop!, signal.target!) : entryAt;
  const signed = (value: number, digits: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

  return (
    <section className="nl-mpos" aria-label="Open position">
      <div className="nl-mpos-top">
        <span className="nl-mpos-id">
          <span className={`nl-cins-side ${signal.direction === "long" ? "is-up" : "is-down"}`}>{signal.direction === "long" ? "Long" : "Short"}</span>
          {held ? <span className="metric-number">held {held}</span> : null}
        </span>
        <span className={`nl-mpos-pl metric-number ${tone}`}>
          {movePips === null ? "—" : `${signed(movePips, 1)} p`}
          {r !== null ? <small>{signed(r, 2)}R</small> : null}
        </span>
      </div>
      {hasTrack ? (
        <span className="nl-mpos-track" aria-hidden="true">
          <span className={`nl-mpos-fill ${tone}`} style={{ left: `${Math.min(entryAt, markAt)}%`, width: `${Math.abs(markAt - entryAt)}%` }} />
          <span className="nl-mpos-mark" style={{ left: `${markAt}%` }} />
        </span>
      ) : null}
      <div className="nl-mpos-ends metric-number">
        <span className="is-down">{signal.stop === null ? "No stop" : `SL ${at(signal.stop)}`}</span>
        <span>Entry {at(signal.entry)}</span>
        <span className="is-up">{signal.target === null ? "No target" : `TP ${at(signal.target)}`}</span>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- status bar */

function untilNextCandle(now: number, timeframe: ChartTimeframe) {
  const minutes = CANDLE_MINUTES[timeframe];
  if (minutes >= 1_440) return null;
  const span = minutes * 60_000;
  const left = Math.ceil((span - (now % span)) / 1_000);
  const mm = Math.floor(left / 60);
  const ss = left % 60;
  return mm >= 60 ? `${Math.floor(mm / 60)}h ${mm % 60}m` : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function serverClock(now: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(now));
}

export function ChartStatusBar({
  source,
  candleCount,
  timeframe,
  openCount = null,
  pendingCount = null,
}: {
  source: string;
  candleCount: number;
  timeframe: ChartTimeframe;
  /** Live trades and orders in the book. */
  openCount?: number | null;
  pendingCount?: number | null;
}) {
  const session = useSession(1_000);
  const live = source === "oanda";
  // The sidebar names the session; this line is about the feed itself.
  const streaming = live && session?.open === true;
  const feed = !live ? "Demo data" : streaming ? "OANDA · streaming" : "OANDA · idle";
  const next = streaming ? untilNextCandle(session.now, timeframe) : null;

  return (
    <footer className="nl-cstatus metric-number">
      <span className="nl-cstatus-feed">
        <span className={`nl-csession-dot${streaming ? "" : " is-closed"}`} aria-hidden="true" />
        {feed}
      </span>
      <span>{candleCount} candles</span>
      {openCount !== null && pendingCount !== null ? <span>{openCount} open · {pendingCount} pending</span> : null}
      {next ? <span>Next candle {next}</span> : null}
      <span className="nl-cstatus-end">Server {session ? `${serverClock(session.now)} ET` : "— ET"}</span>
    </footer>
  );
}
