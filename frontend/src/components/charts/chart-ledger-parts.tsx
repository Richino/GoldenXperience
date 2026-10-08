"use client";

/**
 * Pieces the Night Ledger chart page adds around the existing chart: the OHLC
 * readout over the plot, the trade-health card and the watchlist card in
 * the side column. Layout lives in night-ledger.css (`nl-chart-*`).
 */

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { openRFromLevels } from "@/lib/open-trade-progress";
import type { TradeMonitorDebug } from "@/lib/strategy/trade-monitor";
import type { Candle, CandleSeries } from "@/types/forex";

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
  stop: number;
  target: number;
  riskReward: number;
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
}: {
  signal: ChartPositionCardSignal | null;
  currentPrice: number | null;
  pairLabel: string;
}) {
  const instrument = signal?.instrument ?? null;
  const [read, setRead] = useState<{ instrument: string; value: MonitorRead | null } | null>(null);

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

  const openR = openRFromLevels({
    direction: signal.direction,
    entry: signal.entry,
    stop: signal.stop,
    current: currentPrice,
  });
  const pip = pipSizeFor(signal.instrument);
  const toStop = currentPrice === null ? null : Math.abs(currentPrice - signal.stop) / pip;
  const toTarget = currentPrice === null ? null : Math.abs(signal.target - currentPrice) / pip;
  const rTone = openR === null || Math.abs(openR) < 0.005 ? "" : openR > 0 ? "is-up" : "is-down";
  const monitor = read && read.instrument === signal.instrument ? read.value : null;
  const tiles = [
    { label: "Structure", value: monitor?.structure ?? "—", tone: monitor?.structureTone ?? "" },
    { label: "Momentum", value: monitor?.momentum ?? "—", tone: "" },
    { label: "New S/R", value: monitor?.newSr ?? "—", tone: "" },
  ];

  return (
    <section className="nl-cside-card" aria-labelledby="nl-chealth-title">
      <div className="nl-cside-head">
        <h2 id="nl-chealth-title">Trade health</h2>
        <span className={`metric-number ${rTone}`}>
          {signal.direction === "long" ? "Long" : "Short"} ·{" "}
          {openR === null ? "—" : `${openR >= 0 ? "+" : "−"}${Math.abs(openR).toFixed(2)}R`}
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
      <div className="nl-cpos-foot metric-number">
        <span className="is-down">{toStop === null ? "—" : `${toStop.toFixed(1)} pips to stop`}</span>
        <span className="is-up">{toTarget === null ? "—" : `${toTarget.toFixed(1)} pips to target`}</span>
      </div>
    </section>
  );
}

/**
 * A short list of pairs with live prices and today's change; choosing one
 * switches the chart. Daily change comes from the last two daily candles.
 */
export function ChartWatchlistCard({
  instruments,
  activeInstrument,
  onSelect,
}: {
  instruments: string[];
  activeInstrument: string;
  onSelect: (instrument: string) => void;
}) {
  const quotes = useLiveQuotes();
  // Daily change, plus the latest close as the price until a live quote arrives.
  const [changes, setChanges] = useState<Record<string, { change: number | null; last: number | null }>>({});
  const key = instruments.join(",");

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split(",") : [];
    void Promise.all(
      list.map(async (instrument) => {
        try {
          const response = await fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=D&count=2`), {
            credentials: "include",
            cache: "no-store",
          });
          const payload = (await response.json()) as { data?: CandleSeries };
          const current = payload.data?.candles.at(-1);
          const previous = payload.data?.candles.at(-2);
          return [
            instrument,
            {
              change: current && previous ? ((current.close - previous.close) / previous.close) * 100 : null,
              last: current?.close ?? null,
            },
          ] as const;
        } catch {
          return [instrument, { change: null, last: null }] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setChanges(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!instruments.length) return null;
  return (
    <section className="nl-cside-card nl-cwatch" aria-labelledby="nl-cwatch-title">
      <div className="nl-cside-head">
        <h2 id="nl-cwatch-title">Watchlist</h2>
      </div>
      <div className="nl-cwatch-list">
        {instruments.map((instrument) => {
          const quote = quotes[instrument];
          const mid = quote ? (quote.bid + quote.ask) / 2 : (changes[instrument]?.last ?? null);
          const change = changes[instrument]?.change ?? null;
          const active = instrument === activeInstrument;
          return (
            <button
              key={instrument}
              type="button"
              className={`nl-cwatch-row${active ? " is-active" : ""}`}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(instrument)}
            >
              <b>{displayNameFor(instrument)}</b>
              <span className="metric-number">
                {mid === null ? "—" : formatChartPrice(mid, instrument)}{" "}
                {change !== null ? (
                  <span className={change >= 0 ? "is-up" : "is-down"}>
                    {change >= 0 ? "+" : "−"}
                    {Math.abs(change).toFixed(2)}%
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
