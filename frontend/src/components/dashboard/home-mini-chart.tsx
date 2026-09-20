"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import type { CandleSeries, MajorInstrument } from "@/types/forex";

type LevelTag = { key: "entry" | "stop" | "target"; label: string; price: number; top: number };

function compactPair(instrument: string) {
  return displayNameFor(instrument);
}

function elapsedSince(value: string | null, now: number) {
  if (!value) return null;
  const startedAt = Date.parse(value);
  if (!Number.isFinite(startedAt)) return null;
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function HomeMiniChart({
  instrument,
  liveMid,
  evaluatedAt,
  entry,
  stop,
  target,
}: {
  instrument: MajorInstrument;
  liveMid: number | null;
  evaluatedAt: string | null;
  entry: number;
  stop: number;
  target: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const { resolvedTheme } = useTheme();
  const [changePercent, setChangePercent] = useState<number | null>(null);
  const [levelTags, setLevelTags] = useState<LevelTag[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const dark = resolvedTheme !== "light";
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: dark ? "#6d7176" : "#8a8f96",
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00e59b",
      downColor: "#ff5252",
      borderUpColor: "#00e59b",
      borderDownColor: "#ff5252",
      wickUpColor: "#00e59b",
      wickDownColor: "#ff5252",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [resolvedTheme]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(
          apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=96`),
          { credentials: "include", cache: "no-store" },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: CandleSeries };
        const candles = payload.data?.candles ?? [];
        if (cancelled || !seriesRef.current || candles.length < 2) return;

        seriesRef.current.setData(
          candles.map((candle) => ({
            time: Math.floor(new Date(candle.time).getTime() / 1000) as UTCTimestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })),
        );
        for (const line of levelLinesRef.current) {
          seriesRef.current.removePriceLine(line);
        }
        levelLinesRef.current = [
          seriesRef.current.createPriceLine({ price: entry, color: "#00e59b", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "Entry" }),
          seriesRef.current.createPriceLine({ price: stop, color: "#ff6370", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "SL" }),
          seriesRef.current.createPriceLine({ price: target, color: "#00e59b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "TP" }),
        ];

        // Keep the current trade's full plan in view. A live price move should
        // never push Entry, Stop Loss, or Target outside this home preview.
        const low = Math.min(...candles.map((candle) => candle.low), entry, stop, target);
        const high = Math.max(...candles.map((candle) => candle.high), entry, stop, target);
        const span = Math.max(high - low, Math.abs(entry - stop));
        const padding = span * 0.12;
        seriesRef.current.priceScale().setVisibleRange({ from: low - padding, to: high + padding });
        chartRef.current?.timeScale().fitContent();
        window.requestAnimationFrame(() => {
          if (cancelled || !seriesRef.current) return;
          const labels = [
            { key: "entry" as const, label: "ENTRY", price: entry },
            { key: "stop" as const, label: "STOP", price: stop },
            { key: "target" as const, label: "TARGET", price: target },
          ].flatMap((level) => {
            const top = seriesRef.current?.priceToCoordinate(level.price);
            return top === null || top === undefined
              ? []
              : [{ ...level, top: Number(top) }];
          });
          // Nearby levels can otherwise render on top of each other in this
          // compact chart. Keep each label readable while leaving its level
          // line at the exact executable price.
          const labelPadding = 5;
          const minimumGap = 12;
          const maxTop = Math.max(labelPadding, (hostRef.current?.clientHeight ?? 0) - labelPadding);
          const stackedLabels = labels.sort((left, right) => left.top - right.top);
          for (let index = 0; index < stackedLabels.length; index += 1) {
            const previousTop = index === 0 ? labelPadding : stackedLabels[index - 1].top + minimumGap;
            stackedLabels[index].top = Math.max(previousTop, stackedLabels[index].top);
          }
          const overflow = (stackedLabels.at(-1)?.top ?? 0) - maxTop;
          if (overflow > 0) {
            for (const level of stackedLabels) level.top -= overflow;
          }
          setLevelTags(stackedLabels);
        });

        const first = candles[0]?.close;
        const last = candles.at(-1)?.close;
        if (first && last) {
          setChangePercent(((last - first) / first) * 100);
        }
      } catch {
        // The rail still shows the live mid even if history is unavailable.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [entry, instrument, stop, target]);

  const positive = (changePercent ?? 0) >= 0;
  const age = elapsedSince(evaluatedAt, now);

  return (
    <div className="home-mini-chart">
      <div className="home-mini-chart-meta">
        <span className="home-mini-chart-pair">{compactPair(instrument)}{age ? ` · ${age}` : ""}</span>
        <span className="home-mini-chart-quote">
          <span className="metric-number">
            {liveMid === null ? "—" : formatChartPrice(liveMid, instrument)}
          </span>
          {changePercent !== null ? (
            <span className={positive ? "is-positive" : "is-negative"}>
              {positive ? "+" : ""}
              {changePercent.toFixed(2)}%
            </span>
          ) : null}
        </span>
      </div>
      <div className="home-mini-chart-canvas-wrap">
        <div ref={hostRef} className="home-mini-chart-canvas" />
        <div className="home-mini-chart-level-tags" aria-label="Setup levels">
          {levelTags.map((level) => (
            <span
              key={level.key}
              className={`home-mini-chart-level is-${level.key}`}
              style={{ top: level.top }}
            >
              {level.label} {formatChartPrice(level.price, instrument)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
