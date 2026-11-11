"use client";

/**
 * Pieces the Night Ledger chart page adds around the existing chart: the OHLC
 * readout over the plot and the trade-health card in the side column.
 * Layout lives in night-ledger.css (`nl-chart-*`).
 */

import { useEffect, useState, type ReactNode } from "react";
import { Activity, MoveVertical, Plus, X } from "lucide-react";
import { NewsImpactSheet, type NewsImpactPosition } from "@/components/dashboard/news-impact-sheet";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { currenciesOf, displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { groupedCalendarTitle, groupSimultaneousRows, homeCalendarImpactTier, homeCalendarRows } from "@/lib/news/home-calendar";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import { openRFromLevels } from "@/lib/open-trade-progress";
import { getMarketCondition } from "@/lib/strategy/session";
import type { TradeMonitorDebug } from "@/lib/strategy/trade-monitor";
import type { Candle } from "@/types/forex";

/**
 * The chart legend over the top-left of the plot: "EUR/USD · 15m  O … H … L …
 * C …" with the candle's move in pips, and a chip per active indicator that
 * turns it off.
 */
export function ChartOhlcReadout({
  instrument,
  timeframe,
  candle,
  indicators = [],
  onRemoveIndicator,
}: {
  instrument: string;
  timeframe: string;
  candle: Candle | null | undefined;
  indicators?: Array<{ value: string; label: string }>;
  onRemoveIndicator?: (value: string) => void;
}) {
  const price = (value: number | undefined) => (value === undefined ? "—" : formatChartPrice(value, instrument));
  const movePips = candle ? (candle.close - candle.open) / pipSizeFor(instrument) : null;
  const tone = movePips === null || Math.abs(movePips) < 0.05 ? "" : movePips > 0 ? "is-up" : "is-down";
  return (
    <div className="nl-ohlc">
      <div className="nl-ohlc-row metric-number" aria-hidden="true">
        <span className="nl-ohlc-pair">
          {displayNameFor(instrument)} · {timeframe}
        </span>
        <span><i>O</i> {price(candle?.open)}</span>
        <span><i>H</i> {price(candle?.high)}</span>
        <span><i>L</i> {price(candle?.low)}</span>
        <span className={tone}><i>C</i> {price(candle?.close)}</span>
        {movePips !== null ? (
          <span className={tone}>{`${movePips >= 0 ? "+" : "−"}${Math.abs(movePips).toFixed(1)} p`}</span>
        ) : null}
      </div>
      {indicators.length && onRemoveIndicator ? (
        <div className="nl-ohlc-chips">
          {indicators.map((indicator) => (
            <span key={indicator.value} className="nl-ohlc-chip">
              {indicator.label}
              <button
                type="button"
                className="pressable"
                onClick={() => onRemoveIndicator(indicator.value)}
                aria-label={`Hide ${indicator.label}`}
                title={`Hide ${indicator.label}`}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The chart card's footer: where the candles come from, the market session
 * and how many candles are loaded. The session needs the clock, so it appears
 * after mount.
 */
export function ChartStatusLine({ candleCount, demo, replay }: { candleCount: number; demo: boolean; replay: boolean }) {
  const [session, setSession] = useState<{ open: boolean; label: string } | null>(null);
  useEffect(() => {
    const read = () => {
      const condition = getMarketCondition(new Date());
      setSession({ open: condition.marketOpen, label: condition.marketOpen ? `${condition.label} session` : "Market closed" });
    };
    read();
    const timer = window.setInterval(read, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="nl-chart-status metric-number">
      <span className={`nl-chart-status-feed${demo ? " is-demo" : replay ? " is-replay" : ""}`}>
        <span aria-hidden="true" />
        {demo ? "Demo data" : replay ? "OANDA · replay" : "OANDA · live"}
      </span>
      {session ? <span>{session.label}</span> : null}
      <span className="nl-chart-status-end">{candleCount.toLocaleString("en-US")} candles</span>
    </div>
  );
}

export type ChartPositionCardSignal = {
  pair: string;
  instrument: string;
  direction: "long" | "short";
  entry: number;
  /** Null for a trade placed without a stop or target. */
  stop: number | null;
  target: number | null;
  riskReward: number;
  /** When the trade opened, for the time held. */
  openedAt?: string | null;
};

/**
 * Stop / target editing for a manual trade: the levels are dragged as lines on
 * the chart; the card shows the draft and saves it.
 */
export type ChartHealthLevels = {
  editing: boolean;
  stop: number | null;
  target: number | null;
  /** Which draft levels sit on the wrong side of the price. */
  invalid: { stop: boolean; target: boolean };
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  onToggle: (key: "stop" | "target") => void;
  /** Remove both levels at once: run the trade with no stop or target. */
  onClear: () => void;
  /** What each level must sit beyond: a waiting order checks against its entry. */
  relativeTo?: "entry" | "current price";
};

type MonitorRead = {
  structure: string;
  structureTone: "is-up" | "is-down" | "";
  momentum: string;
  newSr: string;
};

/** Poll cadence: the monitor reads completed M15 candles, so a minute is plenty. */
const MONITOR_POLL_MS = 60_000;

function humanize(value: string) {
  const lower = value.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The open trade on this pair as the canvas "Trade health" card: side and
 * Open R, the monitor's structure / momentum / new S/R reads, and the
 * distance to each exit. Read-only; it never changes the position.
 */
export function ChartHealthCard({
  signal,
  currentPrice,
  pairLabel,
  levels = null,
  tradeAction,
}: {
  signal: ChartPositionCardSignal | null;
  currentPrice: number | null;
  pairLabel: string;
  /** Present when this trade's stop and target can be changed. */
  levels?: ChartHealthLevels | null;
  tradeAction?: ReactNode;
}) {
  const instrument = signal?.instrument ?? null;
  const [read, setRead] = useState<{ instrument: string; value: MonitorRead | null } | null>(null);
  // A ticking clock for the time held (render stays pure).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!instrument) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(apiUrl(`/api/trade-monitor?instrument=${instrument}`), {
          credentials: "include",
          cache: "no-store",
        });
        const payload = (await response.json()) as
          | { monitored: false }
          | { monitored: true; health: { debug: TradeMonitorDebug } };
        if (cancelled) return;
        if (!response.ok || !payload.monitored) {
          setRead({ instrument, value: null });
          return;
        }
        const debug = payload.health.debug;
        setRead({
          instrument,
          value: {
            structure: debug.structureFailed ? "Failed" : "Intact",
            structureTone: debug.structureFailed ? "is-down" : "is-up",
            momentum:
              debug.currentImpulse === "NO_IMPULSE" ? "Flat" : humanize(debug.currentImpulse.replace("_IMPULSE", "")),
            newSr:
              debug.newOpposingStructure === null ? "None" : formatChartPrice(debug.newOpposingStructure, instrument),
          },
        });
      } catch {
        if (!cancelled) setRead({ instrument, value: null });
      }
    };
    void load();
    const timer = window.setInterval(load, MONITOR_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [instrument]);

  if (!signal) {
    return (
      <section className="nl-cside-card" aria-labelledby="nl-chealth-title">
        <div className="nl-cside-head">
          <h2 id="nl-chealth-title">Trade health</h2>
          <span className="nl-cside-tag">{pairLabel}</span>
        </div>
        <div className="nl-cside-body">
          <div className="nl-cside-empty-state">
            <span className="nl-cside-empty-icon" aria-hidden="true"><Activity /></span>
            <div>
              <b>No open trade</b>
              <span>Health shows here once a trade fills.</span>
            </div>
          </div>
          {tradeAction}
        </div>
      </section>
    );
  }

  const long = signal.direction === "long";
  const pip = pipSizeFor(signal.instrument);
  const openR = signal.stop !== null
    ? openRFromLevels({ direction: signal.direction, entry: signal.entry, stop: signal.stop, current: currentPrice })
    : null;
  const openPips = currentPrice === null ? null : ((long ? currentPrice - signal.entry : signal.entry - currentPrice) / pip);
  const toStop = currentPrice === null || signal.stop === null ? null : Math.abs(currentPrice - signal.stop) / pip;
  const toTarget = currentPrice === null || signal.target === null ? null : Math.abs(signal.target - currentPrice) / pip;
  const tone = (value: number | null) => (value === null || Math.abs(value) < 0.005 ? "" : value > 0 ? "is-up" : "is-down");
  const signed = (value: number, digits: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
  const monitor = read && read.instrument === signal.instrument ? read.value : null;
  const heldMinutes = signal.openedAt ? Math.max(0, Math.round((now - Date.parse(signal.openedAt)) / 60_000)) : null;
  const held = heldMinutes === null ? "—"
    : heldMinutes < 60 ? `${heldMinutes}m`
      : heldMinutes < 1440 ? `${Math.floor(heldMinutes / 60)}h ${heldMinutes % 60}m`
        : `${Math.floor(heldMinutes / 1440)}d ${Math.floor((heldMinutes % 1440) / 60)}h`;
  // Structure reads exist for trades placed from Analyze (they carry the
  // analysis); any other trade still gets its live numbers.
  const tiles = monitor
    ? [
        { label: "Structure", value: monitor.structure, tone: monitor.structureTone },
        { label: "Momentum", value: monitor.momentum, tone: "" },
        { label: "New S/R", value: monitor.newSr, tone: "" },
      ]
    : [
        { label: "Open P/L", value: openPips === null ? "—" : `${signed(openPips, 1)}p`, tone: tone(openPips) },
        { label: "Held", value: held, tone: "" },
        { label: "Stop", value: signal.stop === null ? "None" : formatChartPrice(signal.stop, signal.instrument), tone: signal.stop === null ? "is-caution" : "" },
      ];

  return (
    <section className="nl-cside-card" aria-labelledby="nl-chealth-title">
      <div className="nl-cside-head">
        <h2 id="nl-chealth-title">Trade health</h2>
        <span className={`nl-cside-tag metric-number ${tone(openR ?? openPips)}`}>
          {long ? "Long" : "Short"} ·{" "}
          {openR !== null ? `${signed(openR, 2)}R` : openPips !== null ? `${signed(openPips, 1)} pips` : "—"}
        </span>
      </div>
      <div className="nl-cside-body">
      <div className="nl-cpos-grid">
        {tiles.map((tile) => (
          <div key={tile.label}>
            <span>{tile.label}</span>
            <b className={tile.tone}>{tile.value}</b>
          </div>
        ))}
      </div>
      {levels?.editing ? (
        <ChartLevelEditor levels={levels} signal={signal} />
      ) : (
        <>
          {signal.stop === null && signal.target === null ? (
            <p className="nl-cside-note is-caution">No stop or target set: the risk on this trade is not capped.</p>
          ) : (
            <div className="nl-cpos-foot metric-number">
              <span className="is-down">{signal.stop === null ? "No stop" : toStop === null ? "—" : `${toStop.toFixed(1)}p to stop`}</span>
              <span className="is-up">{signal.target === null ? "No target" : toTarget === null ? "—" : `${toTarget.toFixed(1)}p to target`}</span>
            </div>
          )}
          {levels ? (
            <button type="button" className="nl-clevels-start pressable" onClick={levels.onStart}>
              <MoveVertical aria-hidden="true" />
              {signal.stop === null && signal.target === null ? "Set stop & target" : "Move stop & target"}
            </button>
          ) : null}
        </>
      )}
      </div>
    </section>
  );
}

/**
 * A waiting order on this pair in the side column: its entry, stop and target,
 * and the same drag-the-lines editor an open trade gets.
 */
export function ChartPendingLevelsCard({
  signal,
  orderLabel,
  levels,
  cancelAction,
  currentPrice = null,
}: {
  signal: ChartPositionCardSignal;
  orderLabel: string;
  levels: ChartHealthLevels;
  cancelAction?: ReactNode;
  /** The live price, for how far the entry is from it. */
  currentPrice?: number | null;
}) {
  const distance = currentPrice === null ? null : (signal.entry - currentPrice) / pipSizeFor(signal.instrument);
  const rows = [
    { key: "stop", label: "Stop loss", price: signal.stop },
    { key: "target", label: "Take profit", price: signal.target },
  ];
  return (
    <section className="nl-cside-card nl-cpending" aria-labelledby="nl-cpending-title">
      <div className="nl-cside-head">
        <h2 id="nl-cpending-title">Pending order</h2>
        <span className="nl-cside-tag is-pending">{signal.direction === "long" ? "Long" : "Short"} · {orderLabel}</span>
      </div>
      <div className="nl-cside-body">
        <div className="nl-cpending-entry">
          <div>
            <span>Entry</span>
            <b className="metric-number">{formatChartPrice(signal.entry, signal.instrument)}</b>
          </div>
          {distance !== null ? (
            <span className="metric-number">{`${distance >= 0 ? "↑" : "↓"} ${Math.abs(distance).toFixed(1)} p away`}</span>
          ) : null}
        </div>
        {levels.editing ? (
          <ChartLevelEditor levels={levels} signal={signal} />
        ) : (
          <>
            <div className="nl-clevel-list">
              {rows.map((row) => (
                <div key={row.key} className={`is-${row.key}`}>
                  <i aria-hidden="true" />
                  <span>{row.label}</span>
                  <b className={row.price === null ? "is-unset" : "metric-number"}>
                    {row.price === null ? "Not set" : formatChartPrice(row.price, signal.instrument)}
                  </b>
                </div>
              ))}
            </div>
            {signal.stop === null ? (
              <p className="nl-cside-note is-caution">No stop on this order: the whole position is at risk if it fills.</p>
            ) : null}
            <div className="nl-cside-actions">
              <button type="button" className="nl-clevels-start pressable" onClick={levels.onStart}>
                <MoveVertical aria-hidden="true" />
                {signal.stop === null && signal.target === null ? "Set stop & target" : "Move stop & target"}
              </button>
              {cancelAction}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** The draft stop and target while their lines are being dragged on the chart. */
export function ChartLevelEditor({ levels, signal }: { levels: ChartHealthLevels; signal: ChartPositionCardSignal }) {
  const pip = pipSizeFor(signal.instrument);
  const long = signal.direction === "long";
  // R only means something while the stop is on the losing side of entry.
  const risk = levels.stop === null ? null : long ? signal.entry - levels.stop : levels.stop - signal.entry;
  const rows = [
    { key: "stop" as const, label: "Stop loss", price: levels.stop, invalid: levels.invalid.stop, hint: long ? "below" : "above" },
    { key: "target" as const, label: "Take profit", price: levels.target, invalid: levels.invalid.target, hint: long ? "above" : "below" },
  ];
  const anyInvalid = levels.invalid.stop || levels.invalid.target;
  return (
    <div className="nl-clevels">
      <div className="nl-clevels-mobile-head"><b>Edit levels</b><span>Drag SL / TP on chart</span></div>
      <p className="nl-clevels-hint">Drag the lines on the chart to place them.</p>
      {rows.map((row) => {
        const fromEntry = row.price === null ? null : ((long ? row.price - signal.entry : signal.entry - row.price) / pip);
        const reward = row.price === null || risk === null || risk <= 0 ? ""
          : row.key === "stop" ? " · −1.0R"
            : ` · ${(Math.abs(row.price - signal.entry) / risk).toFixed(1)}R`;
        return (
          <div key={row.key} className={`nl-clevels-row is-${row.key}${row.invalid ? " is-invalid" : ""}`}>
            <i aria-hidden="true" />
            <div>
              <span>{row.label}</span>
              <b className="metric-number">
                {row.price === null
                  ? "None"
                  : <>
                      {formatChartPrice(row.price, signal.instrument)}
                      {/* Its own span so phones can drop it to a second line. */}
                      <span className="nl-clevels-detail"><span className="nl-clevels-sep"> · </span>{fromEntry! >= 0 ? "+" : "−"}{Math.abs(fromEntry!).toFixed(1)}p{reward}</span>
                    </>}
              </b>
              {row.invalid ? <small>Must be {row.hint} the {levels.relativeTo ?? "current price"}.</small> : null}
            </div>
            <button type="button" className="nl-clevels-toggle pressable" onClick={() => levels.onToggle(row.key)}
              aria-label={`${row.price === null ? "Add" : "Remove"} ${row.label.toLowerCase()}`} disabled={levels.saving}>
              {row.price === null ? <Plus aria-hidden="true" /> : <X aria-hidden="true" />}
              {row.price === null ? "Add" : "Remove"}
            </button>
          </div>
        );
      })}
      {levels.stop === null ? (
        <p className="nl-clevels-warning" role="note">
          No stop loss: this trade's loss isn't capped until you close it.
        </p>
      ) : null}
      {levels.error ? <p className="nl-clevels-error" role="alert">{levels.error}</p> : null}
      <div className="nl-clevels-actions">
        {levels.stop !== null || levels.target !== null ? (
          <button type="button" className="nl-clevels-none pressable" onClick={levels.onClear}
            aria-label="Remove both levels" disabled={levels.saving}>
            Clear levels
          </button>
        ) : null}
        <button type="button" className="nl-clevels-cancel pressable" onClick={levels.onCancel} disabled={levels.saving}>
          Cancel
        </button>
        <button
          type="button"
          className="nl-clevels-save pressable"
          onClick={levels.onSave}
          disabled={levels.saving || !levels.dirty || anyInvalid}
        >
          {levels.saving ? "Saving…" : "Save levels"}
        </button>
      </div>
    </div>
  );
}

const newsDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });
const newsTime = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" });

function newsCountdown(timestamp: string, now: number) {
  const minutes = Math.max(0, Math.round((Date.parse(timestamp) - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Medium and high-impact releases for this pair's two currencies, in the same
 * rows as Home's news card: today's releases first, then what is coming. A
 * row opens the impact drawer for that release.
 */
export function ChartNewsCard({
  instrument,
  position = null,
}: {
  instrument: string;
  /** The open trade on this pair, so the impact drawer lists it first. */
  position?: NewsImpactPosition | null;
}) {
  const { snapshot: calendar, loading } = useEconomicCalendar();
  const [openId, setOpenId] = useState<string | null>(null);
  // A clock that only exists after mount, so SSR and hydration agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const { base, quote } = currenciesOf(instrument);
  const forPair = <T extends { currency: string }>(events: T[]) =>
    events.filter((event) => event.currency === base || event.currency === quote);
  // Same-currency releases at the same moment are one row and one sheet.
  const rows = now === null ? [] : groupSimultaneousRows(homeCalendarRows(forPair(calendar.recentEvents ?? []), forPair(calendar.events), now));
  const openRow = rows.find((row) => row.id === openId) ?? null;
  // The soonest release still to come is highlighted.
  const nextId = rows.find((row) => row.state !== "released" && row.state !== "live")?.id ?? null;
  const openEvent = openRow ? openRow.events[0]! : null;

  return (
    <section className="nl-cside-card nl-cnews" aria-labelledby="nl-cnews-title">
      <div className="nl-cside-head">
        <h2 id="nl-cnews-title">Upcoming news</h2>
        <span className="nl-cside-tag metric-number nl-cnews-meta">{base} · {quote} · ET</span>
      </div>
      {loading || now === null ? (
        <p className="nl-cside-empty">Loading calendar…</p>
      ) : !calendar.connected ? (
        <p className="nl-cside-note is-caution">Calendar unavailable: check the news yourself before trading.</p>
      ) : rows.length ? (
        <div className="nl-news-list">
          {rows.map((event) => {
            const high = homeCalendarImpactTier(event.impact) === "high";
            const next = event.id === nextId;
            const status = event.state === "live" ? "Now" : event.state === "released" ? "Released" : newsCountdown(event.timestamp, now);
            return (
              <button
                key={event.id}
                type="button"
                className={`nl-news-row is-${event.state}${next ? " is-next" : ""}`}
                onClick={() => setOpenId(event.id)}
                aria-label={`${event.currency} ${groupedCalendarTitle(event.events)}, ${status}, ${high ? "high" : "medium"} impact: see how it affects ${event.currency} pairs`}
              >
                <span className="nl-news-when metric-number">
                  <span>{newsDay.format(new Date(event.timestamp)).toUpperCase()}</span>
                  <b>{newsTime.format(new Date(event.timestamp))}</b>
                </span>
                <span className="nl-news-copy">
                  <b>{event.currency} · {groupedCalendarTitle(event.events)}</b>
                  <span>{next ? `Next · ${status}` : status}</span>
                </span>
                <span className={`nl-impact ${high ? "is-high" : "is-medium"}`}>{high ? "HIGH" : "MED"}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="nl-cside-empty">No medium or high-impact {base} or {quote} news this week.</p>
      )}
      <NewsImpactSheet
        event={openEvent}
        related={openRow ? openRow.events.slice(1) : []}
        positions={position ? [position] : []}
        onClose={() => setOpenId(null)}
        now={now ?? 0}
      />
    </section>
  );
}
