"use client";

/**
 * Pieces the Night Ledger chart page adds around the existing chart: the OHLC
 * readout over the plot and the trade-health card in the side column.
 * Layout lives in night-ledger.css (`nl-chart-*`).
 */

import { useEffect, useState } from "react";
import { MoveVertical, Plus, X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { openRFromLevels } from "@/lib/open-trade-progress";
import type { TradeMonitorDebug } from "@/lib/strategy/trade-monitor";
import type { Candle } from "@/types/forex";

/** "EUR/USD · 15m  O … H … L … C …" over the top-left of the plot. */
export function ChartOhlcReadout({
  instrument,
  timeframe,
  candle,
}: {
  instrument: string;
  timeframe: string;
  candle: Candle | null | undefined;
}) {
  const price = (value: number | undefined) => (value === undefined ? "—" : formatChartPrice(value, instrument));
  return (
    <div className="nl-ohlc metric-number" aria-hidden="true">
      <span className="nl-ohlc-pair">
        {displayNameFor(instrument)} · {timeframe}
      </span>
      <span><i>O</i> {price(candle?.open)}</span>
      <span><i>H</i> {price(candle?.high)}</span>
      <span><i>L</i> {price(candle?.low)}</span>
      <span><i>C</i> {price(candle?.close)}</span>
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
}: {
  signal: ChartPositionCardSignal | null;
  currentPrice: number | null;
  pairLabel: string;
  /** Present when this trade's stop and target can be changed. */
  levels?: ChartHealthLevels | null;
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
        </div>
        <p className="nl-cside-empty">No open trade on {pairLabel}.</p>
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
  const monitorChecked = read !== null && read.instrument === signal.instrument;
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
        <span className={`metric-number ${tone(openR ?? openPips)}`}>
          {long ? "Long" : "Short"} ·{" "}
          {openR !== null ? `${signed(openR, 2)}R` : openPips !== null ? `${signed(openPips, 1)} pips` : "—"}
        </span>
      </div>
      <div className="nl-cpos-grid">
        {tiles.map((tile) => (
          <div key={tile.label}>
            <span>{tile.label}</span>
            <b className={tile.tone}>{tile.value}</b>
          </div>
        ))}
      </div>
      {levels?.editing ? (
        <LevelEditor levels={levels} signal={signal} />
      ) : (
        <>
          {signal.stop === null && signal.target === null ? (
            <p className="nl-cside-note is-caution">No stop or target set: the risk on this trade is not capped.</p>
          ) : (
            <div className="nl-cpos-foot metric-number">
              <span className="is-down">{signal.stop === null ? "No stop" : toStop === null ? "—" : `${toStop.toFixed(1)} pips to stop`}</span>
              <span className="is-up">{signal.target === null ? "No target" : toTarget === null ? "—" : `${toTarget.toFixed(1)} pips to target`}</span>
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
      {monitorChecked && !monitor && !levels?.editing ? (
        <p className="nl-cside-note">Structure checks run on trades placed from Analyze.</p>
      ) : null}
    </section>
  );
}

/** The draft stop and target while their lines are being dragged on the chart. */
function LevelEditor({ levels, signal }: { levels: ChartHealthLevels; signal: ChartPositionCardSignal }) {
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
      <p className="nl-clevels-hint">Drag the lines on the chart to place them.</p>
      {rows.map((row) => {
        const fromEntry = row.price === null ? null : ((long ? row.price - signal.entry : signal.entry - row.price) / pip);
        const reward = row.key === "target" && row.price !== null && risk !== null && risk > 0
          ? ` · ${(Math.abs(row.price - signal.entry) / risk).toFixed(1)}R`
          : "";
        return (
          <div key={row.key} className={`nl-clevels-row is-${row.key}${row.invalid ? " is-invalid" : ""}`}>
            <i aria-hidden="true" />
            <div>
              <span>{row.label}</span>
              <b className="metric-number">
                {row.price === null
                  ? "None"
                  : `${formatChartPrice(row.price, signal.instrument)} · ${fromEntry! >= 0 ? "+" : "−"}${Math.abs(fromEntry!).toFixed(1)}p${reward}`}
              </b>
              {row.invalid ? <small>Must be {row.hint} the current price.</small> : null}
            </div>
            <button type="button" className="nl-clevels-toggle pressable" onClick={() => levels.onToggle(row.key)}>
              {row.price === null ? <Plus aria-hidden="true" /> : <X aria-hidden="true" />}
              {row.price === null ? "Add" : "Remove"}
            </button>
          </div>
        );
      })}
      {levels.error ? <p className="nl-clevels-error" role="alert">{levels.error}</p> : null}
      <div className="nl-clevels-actions">
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
