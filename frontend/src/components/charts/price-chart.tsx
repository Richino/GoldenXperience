"use client";

import { useId, useMemo, useRef, useState } from "react";
import { precisionFor } from "@/lib/instruments/catalog";
import type { CandleSeries } from "@/types/forex";

interface Point {
  x: number;
  y: number;
}

function pointsToString(points: Point[]) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function formatPrice(value: number, instrument: string) {
  return value.toFixed(precisionFor(instrument));
}

function monthLabel(time: string) {
  return new Date(time).toLocaleDateString("en-US", { month: "short" });
}

function uniqueMonthIndices(
  candles: { time: string }[],
): { index: number; label: string }[] {
  const seen = new Set<string>();
  const labels: { index: number; label: string }[] = [];

  candles.forEach((candle, index) => {
    const month = monthLabel(candle.time);
    if (!seen.has(month)) {
      seen.add(month);
      labels.push({ index, label: month });
    }
  });

  return labels;
}

export function PriceChart({
  series,
  height = 280,
  variant = "candle",
}: {
  series: CandleSeries;
  height?: number;
  showLevels?: boolean;
  variant?: "candle" | "line";
}) {
  const chartId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const candles = series.candles.slice(-56);

  const layout = useMemo(() => {
    if (!candles.length) return null;

    const width = 760;
    const padding = { top: 16, right: 16, bottom: 36, left: 8 };
    const values = candles.flatMap((candle) => [candle.high, candle.low]);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const range = high - low || 1;
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const xStep = plotWidth / candles.length;
    const yFor = (value: number) =>
      padding.top + ((high - value) / range) * plotHeight;

    return {
      width,
      padding,
      low,
      high,
      plotWidth,
      plotHeight,
      xStep,
      yFor,
      monthLabels: uniqueMonthIndices(candles),
    };
  }, [candles, height]);

  if (!candles.length || !layout) {
    return (
      <div
        className="grid place-items-center rounded-3xl bg-[color:var(--surface-raised)] text-sm text-[color:var(--muted)]"
        style={{ height }}
      >
        No candle data available.
      </div>
    );
  }

  const {
    width,
    padding,
    plotHeight,
    xStep,
    yFor,
    monthLabels,
  } = layout;

  const activeIndex = hoverIndex ?? candles.length - 1;
  const activeCandle = candles[activeIndex];
  const prevClose =
    activeIndex > 0 ? candles[activeIndex - 1].close : activeCandle.open;
  const change = activeCandle.close - prevClose;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;
  const positive = change >= 0;
  const activeX = padding.left + activeIndex * xStep + xStep / 2;
  const activeY = yFor(activeCandle.close);

  const closes = candles.map((candle) => candle.close);
  const linePoints = closes.map((value, index) => ({
    x: padding.left + index * xStep + xStep / 2,
    y: yFor(value),
  }));
  const areaPoints = [
    ...linePoints,
    { x: linePoints.at(-1)!.x, y: padding.top + plotHeight },
    { x: linePoints[0].x, y: padding.top + plotHeight },
  ];
  const isUpTrend = closes.at(-1)! >= closes[0];
  const lineColor = isUpTrend ? "var(--success)" : "var(--danger)";

  function handlePointer(clientX: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const relativeX = ((clientX - rect.left) / rect.width) * width;
    const index = Math.floor((relativeX - padding.left) / xStep);
    setHoverIndex(Math.max(0, Math.min(candles.length - 1, index)));
  }

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-3xl bg-transparent"
      onMouseLeave={() => setHoverIndex(null)}
      onMouseMove={(event) => handlePointer(event.clientX)}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (touch) handlePointer(touch.clientX);
      }}
    >
      <svg
        aria-label={`${series.instrument.replace("_", "/")} ${variant} chart`}
        className="relative block h-auto w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={`${chartId}-line-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
          <filter id={`${chartId}-glow`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur result="blur" stdDeviation="2.5" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {variant === "line" ? (
          <>
            <polygon
              points={pointsToString(areaPoints)}
              fill={`url(#${chartId}-line-fill)`}
            />
            <polyline
              points={pointsToString(linePoints)}
              fill="none"
              filter={`url(#${chartId}-glow)`}
              stroke={lineColor}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
            />
          </>
        ) : (
          candles.map((candle, index) => {
            const x = padding.left + index * xStep + xStep / 2;
            const candleUp = candle.close >= candle.open;
            const bodyTop = yFor(Math.max(candle.open, candle.close));
            const bodyHeight = Math.max(
              2,
              Math.abs(yFor(candle.open) - yFor(candle.close)),
            );
            const bodyWidth = Math.max(3, xStep * 0.62);
            const color = candleUp ? "var(--success)" : "var(--danger)";

            return (
              <g key={candle.time} opacity={hoverIndex === null || hoverIndex === index ? 1 : 0.45}>
                <line
                  x1={x}
                  x2={x}
                  y1={yFor(candle.high)}
                  y2={yFor(candle.low)}
                  stroke={color}
                  strokeWidth="1.2"
                />
                <rect
                  x={x - bodyWidth / 2}
                  y={bodyTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  rx="1.5"
                  fill={color}
                />
              </g>
            );
          })
        )}

        <line
          x1={activeX}
          x2={activeX}
          y1={padding.top}
          y2={padding.top + plotHeight}
          stroke="var(--success)"
          strokeOpacity="0.35"
          strokeWidth="1"
        />

        <circle
          cx={activeX}
          cy={activeY}
          fill="var(--success)"
          filter={`url(#${chartId}-glow)`}
          r="5"
          stroke="var(--background)"
          strokeWidth="2"
        />

        {monthLabels.map(({ index, label }) => (
          <text
            key={`${label}-${index}`}
            x={padding.left + index * xStep + xStep / 2}
            y={height - 10}
            fill="var(--muted)"
            fontFamily="Geist, sans-serif"
            fontSize="11"
            textAnchor="middle"
          >
            {label}
          </text>
        ))}
      </svg>

      <div
        className="pointer-events-none absolute rounded-full bg-[color:var(--success)] px-3 py-1.5 text-xs font-semibold text-[color:var(--background)] shadow-lg"
        style={{
          left: `${(activeX / width) * 100}%`,
          top: Math.max(8, ((activeY - 36) / height) * 100) + "%",
          transform: "translateX(-50%)",
        }}
      >
        <span className="metric-number">
          {formatPrice(activeCandle.close, series.instrument)}
        </span>
        <span className="ml-1.5 opacity-80">
          {positive ? "+" : ""}
          {changePercent.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}
