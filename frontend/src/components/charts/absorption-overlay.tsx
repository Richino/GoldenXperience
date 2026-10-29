"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { CandleSeries } from "@/types/forex";
import { calculateAbsorption, type AbsorptionZone } from "@/lib/indicators/absorption";
import { useAbsorptionSettings } from "@/lib/indicators/absorption-settings";
import { candleEnd } from "@/lib/strategy/candle-clock";
import { formatChartPrice } from "@/lib/chart-utils";
import { usePairTrend } from "./trend-label";
import { apiUrl } from "@/lib/api/url";
import type { ChartBox } from "./chart-box-primitive";
import styles from "./absorption.module.css";

const GREEN = "#42c98b", RED = "#f17569";
export function useAbsorptionAnalysis(series: CandleSeries, enabled: boolean) {
  const settings = useAbsorptionSettings();
  // Ignore the live, incomplete candle: ticks do not rerun a historical calculation.
  const completedKey = useMemo(() => enabled && series.source === "oanda" ? series.candles.filter(c => c.complete).map(c => `${c.time}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}`).join("|") : "", [enabled, series.source, series.candles]);
  const result = useMemo(() => enabled && completedKey ? calculateAbsorption(series.candles, series.instrument, series.granularity, settings) : { zones: [], events: [], diagnostics: [] },
    // The fingerprint includes every completed OHLCV value, and excludes intrabar ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [completedKey, enabled, settings, series.instrument, series.granularity]);
  const visibleZones = useMemo(() => result.zones.filter(z => z.direction === "bullish" ? settings.showBullish : settings.showBearish), [result.zones, settings.showBullish, settings.showBearish]);
  const boxes: ChartBox[] = useMemo(() => visibleZones.map(z => {
    let end = Date.parse(z.time);
    for (let i = 0; i < settings.projection; i++) end = candleEnd(end, series.granularity);
    return { key: z.id, startTime: z.time, endTime: new Date(end).toISOString(), projectionBars: settings.projection,
      top: z.top, bottom: z.bottom, color: z.direction === "bullish" ? GREEN : RED, faded: z.status !== "Confirmed", interactive: true };
  }), [visibleZones, settings.projection, series.granularity]);
  return { ...result, boxes, visibleZones, settings };
}

export function AbsorptionOverlay({ chartRef, mainSeriesRef, epoch, series, enabled, analysis, alertsEnabled }: {
  chartRef: { current: IChartApi | null }; mainSeriesRef: { current: ISeriesApi<SeriesType> | null }; epoch: number;
  series: CandleSeries; enabled: boolean; alertsEnabled: boolean; analysis: ReturnType<typeof useAbsorptionAnalysis>;
}) {
  const { visibleZones, settings, events, diagnostics } = analysis;
  const { resolvedTheme } = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = visibleZones.find(z => z.id === selectedId);
  const [markers, setMarkers] = useState<Array<{ key: string; x: number; y: number; zone: AbsorptionZone; confirmation: boolean }>>([]);
  const [alertError, setAlertError] = useState(false);
  const trend = usePairTrend(series.instrument, enabled && !!selected);
  const alertCursor = useRef<{ key: string; time: number } | null>(null);
  const key = `${series.instrument}:${series.granularity}:${JSON.stringify(settings)}:${enabled}:${alertsEnabled}`;
  const lastComplete = series.candles.filter(c => c.complete).at(-1)?.time ?? "";
  useEffect(() => {
    const latest = Date.parse(lastComplete);
    if (!enabled || !alertsEnabled || series.source !== "oanda" || !Number.isFinite(latest)) { alertCursor.current = null; return; }
    if (alertCursor.current?.key !== key) { alertCursor.current = { key, time: latest }; return; }
    const fresh = events.filter(e => Date.parse(e.time) > alertCursor.current!.time
      && Date.now() - candleEnd(Date.parse(e.time), series.granularity) <= 2 * 3_600_000).slice(-16);
    alertCursor.current.time = Math.max(latest, alertCursor.current.time);
    if (!fresh.length) return;
    const controller = new AbortController(); let retry: ReturnType<typeof setTimeout> | undefined;
    const send = async (attempt = 0) => {
      try {
        const response = await fetch(apiUrl("/api/indicators/absorption/alerts"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instrument: series.instrument, timeframe: series.granularity, settings, eventIds: fresh.map(e => e.id) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
        if (!response.ok) throw new Error("Absorption alert delivery unavailable");
        setAlertError(false);
      } catch { if (!controller.signal.aborted) { setAlertError(true); if (attempt < 3) retry = setTimeout(() => void send(attempt + 1), 5000 * (attempt + 1)); } }
    };
    void send(); return () => { controller.abort(); clearTimeout(retry); };
  }, [lastComplete, key, enabled, alertsEnabled, events, series.source, series.instrument, series.granularity, settings]);

  useEffect(() => {
    const chart = chartRef.current, main = mainSeriesRef.current;
    if (!chart || !main || !enabled) return;
    let frame = 0, previous: string | null = null;
    const click: Parameters<IChartApi["subscribeClick"]>[0] = param => {
      if (typeof param.hoveredObjectId === "string" && param.hoveredObjectId.startsWith("abs-v1:")) setSelectedId(param.hoveredObjectId);
    };
    chart.subscribeClick(click);
    const paint = () => {
      if (chartRef.current !== chart || mainSeriesRef.current !== main) return;
      const positions: typeof markers = [];
      for (const zone of visibleZones) {
        const add = (time: string, price: number, confirmation: boolean) => {
          const x = chart.timeScale().timeToCoordinate(Math.floor(Date.parse(time) / 1000) as Time), y = main.priceToCoordinate(price);
          if (x !== null && y !== null && x >= 0 && x <= chart.timeScale().width() && y >= 0 && y <= chart.paneSize().height) positions.push({ key: `${zone.id}:${confirmation}`, x, y: y + (zone.direction === "bullish" ? 22 : -22), zone, confirmation });
        };
        if (settings.showCandidates) add(zone.time, zone.direction === "bullish" ? zone.low : zone.high, false);
        if (settings.showConfirmations && zone.confirmationTime && zone.confirmationPrice !== null) add(zone.confirmationTime, zone.confirmationPrice, true);
      }
      const signature = positions.map(m => `${m.key}:${m.x.toFixed(1)}:${m.y.toFixed(1)}:${m.zone.status}:${m.zone.score}`).join("|");
      if (signature !== previous) { previous = signature; setMarkers(positions); }
      frame = requestAnimationFrame(paint);
    };
    paint(); return () => { cancelAnimationFrame(frame); chart.unsubscribeClick(click); };
  }, [chartRef, mainSeriesRef, epoch, enabled, visibleZones, settings]);
  if (!enabled) return null;
  const fmt = (n: number) => formatChartPrice(n, series.instrument);
  const at = (time: string | null) => time ? new Date(time).toLocaleString() : "—";
  const context = selected && trend?.h4?.direction ? (() => {
    const aligned = selected.direction === "bullish" ? trend.h4.direction === "UPTREND" : trend.h4.direction === "DOWNTREND";
    return ["UPTREND", "DOWNTREND"].includes(trend.h4.direction) ? aligned ? "Aligned with H4 trend" : "Against H4 trend" : "H4 direction is mixed or unclear";
  })() : "H4 context unavailable";
  return <>
    <div className={styles.layer} aria-label="GX Heavy Absorption overlays">
      {markers.map(marker => <button key={marker.key} type="button" className={styles.marker} data-status={marker.confirmation ? "Confirmed" : marker.zone.status}
        style={{ left: marker.x, top: marker.y, color: marker.zone.direction === "bullish" ? (resolvedTheme === "dark" ? GREEN : "#08794e") : (resolvedTheme === "dark" ? RED : "#b64035") }} onClick={() => setSelectedId(marker.zone.id)}
        aria-label={`${marker.confirmation ? "Confirmation" : `Detection, ${marker.zone.status}`} ${marker.zone.direction} absorption ${marker.zone.score}, ${marker.confirmation ? marker.zone.confirmationTime : marker.zone.time}`}>
        {marker.confirmation ? marker.zone.direction === "bullish" ? "▲ BUY" : "▼ SELL" : `${marker.zone.direction === "bullish" ? "▲ BULL" : "▼ BEAR"} ABS${settings.showScores ? ` ${marker.zone.score}` : ""}`}
      </button>)}
    </div>
    {selected ? <section className={styles.analysis} role="region" aria-label="GX Absorption Analysis">
      <header><b>GX Absorption Analysis</b><button type="button" aria-label="Close absorption analysis" onClick={() => setSelectedId(null)}>×</button></header>
      <dl>{Object.entries({ Pair: selected.instrument.replace("_", "/"), Timeframe: selected.timeframe, Type: `${selected.direction} absorption`, Strength: `${selected.score}/100 · heuristic`,
        "Relative tick activity": `${selected.relativeVolume.toFixed(2)}×`, "Wick ratio": `${Math.round(selected.wickRatio * 100)}%`, "Zone high": fmt(selected.top), "Zone low": fmt(selected.bottom),
        "Detection candle opens": at(selected.time), "Detected at close": at(new Date(candleEnd(Date.parse(selected.time), selected.timeframe)).toISOString()), Status: selected.status, "Confirmation price": selected.confirmationPrice === null ? "—" : fmt(selected.confirmationPrice), "Confirmed at close": selected.confirmationTime ? at(new Date(candleEnd(Date.parse(selected.confirmationTime), selected.timeframe)).toISOString()) : "—",
        Reason: selected.reason ?? "—", "Current H4 context": context }).map(([label, value]) => <span key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{value}</dd></span>)}</dl>
      <p>OANDA price-update activity and candle rejection proxy. No order-flow delta, probability, or automatic trade execution.</p>
    </section> : null}
    {alertError ? <span className="absolute bottom-2 left-2 text-xs text-[color:var(--muted)]">Absorption alert delivery unavailable</span> : null}
    {process.env.NODE_ENV === "development" ? <details className="absolute bottom-1 left-1 z-10 rounded bg-[color:var(--surface)] p-1 text-[10px]"><summary>Absorption diagnostics</summary><pre className={styles.diagnostic}>{JSON.stringify(diagnostics.at(-1) ?? { reason: "Waiting for verified completed OANDA candles" }, null, 2)}</pre></details> : null}
  </>;
}
