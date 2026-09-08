"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import type { CandleSeries, MajorInstrument } from "@/types/forex";

function compactPair(instrument: string) {
  return displayNameFor(instrument);
}

export function HomeMiniChart({
  instrument,
  liveMid,
}: {
  instrument: MajorInstrument;
  liveMid: number | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const { resolvedTheme } = useTheme();
  const [changePercent, setChangePercent] = useState<number | null>(null);

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
      downColor: "#ff6370",
      borderUpColor: "#00e59b",
      borderDownColor: "#ff6370",
      wickUpColor: "#00e59b",
      wickDownColor: "#ff6370",
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
        chartRef.current?.timeScale().fitContent();

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
  }, [instrument]);

  const positive = (changePercent ?? 0) >= 0;

  return (
    <div className="home-mini-chart">
      <div className="home-mini-chart-meta">
        <span className="home-mini-chart-pair">{compactPair(instrument)} · 15M</span>
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
      <div ref={hostRef} className="home-mini-chart-canvas" />
    </div>
  );
}
