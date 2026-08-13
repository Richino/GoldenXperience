"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountBalanceHistoryPoint } from "@/types/forex";

export type AccountChartPoint = {
  label: string;
  axisLabel: string;
  value: number;
  at: string;
  movementCount: number;
  includesOpenPL: boolean;
  index: number;
};

/** Real wall-clock periods for account profit and loss. */
export type AccountChartRange = "1h" | "1d" | "1w" | "1m";

const RANGES: AccountChartRange[] = ["1h", "1d", "1w", "1m"];

const RANGE_CONFIG: Record<AccountChartRange, { tab: string; label: string; durationMs: number; bucketMs: number }> = {
  "1h": { tab: "1H", label: "the last hour", durationMs: 60 * 60_000, bucketMs: 5 * 60_000 },
  "1d": { tab: "1D", label: "the last day", durationMs: 24 * 60 * 60_000, bucketMs: 2 * 60 * 60_000 },
  "1w": { tab: "1W", label: "the last week", durationMs: 7 * 24 * 60 * 60_000, bucketMs: 24 * 60 * 60_000 },
  "1m": { tab: "1M", label: "the last 30 days", durationMs: 30 * 24 * 60 * 60_000, bucketMs: 3 * 24 * 60 * 60_000 },
};

function moneyCompact(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function moneyExact(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatAxisTick(value: number, range: AccountChartRange) {
  const date = new Date(value);
  if (range === "1h" || range === "1d") {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: range === "1h" ? "2-digit" : undefined,
    }).format(date);
  }
  if (range === "1w") {
    return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function formatBucketLabel(start: number, end: number, range: AccountChartRange) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (range === "1h" || range === "1d") {
    const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
    return `${formatter.format(startDate)}–${formatter.format(endDate)}`;
  }
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${formatter.format(startDate)}–${formatter.format(endDate)}`;
}

/**
 * Build fixed time buckets from broker-reported P/L.
 *
 * Each bar is the net result inside that slice of time. The final bar also
 * includes current unrealised P/L so the sum agrees with the live period total.
 */
export function buildAccountAmountSeries({
  unrealizedPL,
  history,
  range,
  now = Date.now(),
}: {
  unrealizedPL: number;
  history: AccountBalanceHistoryPoint[];
  range: AccountChartRange;
  now?: number;
}): AccountChartPoint[] {
  const config = RANGE_CONFIG[range];
  const cutoff = now - config.durationMs;
  const bucketCount = Math.ceil(config.durationMs / config.bucketMs);
  const points: AccountChartPoint[] = Array.from({ length: bucketCount }, (_, index) => {
    const start = cutoff + index * config.bucketMs;
    const end = Math.min(start + config.bucketMs, now);
    return {
      label: formatBucketLabel(start, end, range),
      axisLabel: formatAxisTick(start + (end - start) / 2, range),
      value: 0,
      at: new Date(start).toISOString(),
      movementCount: 0,
      includesOpenPL: index === bucketCount - 1 && unrealizedPL !== 0,
      index,
    };
  });

  const movements = history
    .map((movement) => ({
      at: new Date(movement.time).getTime(),
      pl: movement.change,
    }))
    .filter((movement) => Number.isFinite(movement.at) && movement.at >= cutoff && movement.at <= now && Number.isFinite(movement.pl))
    .sort((a, b) => a.at - b.at);

  for (const movement of movements) {
    const bucketIndex = Math.min(Math.floor((movement.at - cutoff) / config.bucketMs), bucketCount - 1);
    const point = points[bucketIndex];
    if (!point) continue;
    point.value += movement.pl;
    point.movementCount += 1;
  }

  const finalPoint = points.at(-1);
  if (finalPoint) finalPoint.value += unrealizedPL;
  for (const point of points) point.value = Number(point.value.toFixed(2));

  return points;
}

/**
 * Whether the plotted window ends above where it opened.
 *
 * Exported so the card around the chart can be tinted from the same signal the
 * line is coloured from. Reading it twice from two different measures is how
 * the hero ended up green around a red chart.
 */
export function accountSeriesRose(series: AccountChartPoint[]) {
  return series.reduce((sum, point) => sum + point.value, 0) >= 0;
}

function ActiveValueLabel({
  point,
  currency,
}: {
  point: AccountChartPoint | null;
  currency: string;
}) {
  if (!point) return null;

  return (
    <div className="account-chart-active-label metric-number" aria-live="polite">
      {moneyExact(point.value, currency)}
    </div>
  );
}

type TooltipPayloadItem = { payload?: AccountChartPoint };

/**
 * The point under the pointer, shown beside it. The pill at the top of the
 * canvas carries the same amount because on touch the finger covers this.
 */
function AccountChartTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: readonly TooltipPayloadItem[];
  currency: string;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="account-chart-tooltip">
      <span className="account-chart-tooltip-value metric-number">
        {moneyExact(point.value, currency)}
      </span>
      <span className="account-chart-tooltip-time">
        {point.label} · {point.movementCount} closed {point.movementCount === 1 ? "change" : "changes"}
        {point.includesOpenPL ? " + open P/L" : ""}
      </span>
    </div>
  );
}

function PnLDot({
  cx,
  cy,
  payload,
  radius = 3.5,
}: {
  cx?: number;
  cy?: number;
  payload?: AccountChartPoint;
  radius?: number;
}) {
  if (cx === undefined || cy === undefined || !payload) return null;
  const fill = payload.value > 0
    ? "var(--success)"
    : payload.value < 0
      ? "var(--danger)"
      : "var(--muted)";
  return (
    <circle
      cx={cx}
      cy={cy}
      r={radius}
      fill={fill}
      stroke="var(--hero-surface)"
      strokeWidth={2}
      pointerEvents="none"
    />
  );
}

export function AccountAmountChart({
  series,
  currency,
  range,
  onRangeChange,
}: {
  series: AccountChartPoint[];
  currency: string;
  range: AccountChartRange;
  onRangeChange: (range: AccountChartRange) => void;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const values = useMemo(() => series.map((point) => point.value), [series]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const room = Math.max((max - min) * 0.12, 1);
  const activePoint = activeIndex === null ? null : (series[activeIndex] ?? null);
  const movementCount = series.reduce((sum, point) => sum + point.movementCount, 0);
  const netChange = series.reduce((sum, point) => sum + point.value, 0);
  const stroke = netChange >= 0 ? "var(--chart-up)" : "var(--chart-down)";
  const tickInterval = range === "1w" ? 0 : range === "1m" ? 1 : 2;

  function handleChartFocus(event: { activeTooltipIndex?: number | string | null }) {
    if (typeof event.activeTooltipIndex === "number") {
      setActiveIndex(event.activeTooltipIndex);
      return;
    }
    if (typeof event.activeTooltipIndex === "string") {
      const parsed = Number(event.activeTooltipIndex);
      setActiveIndex(Number.isFinite(parsed) ? parsed : null);
      return;
    }
    setActiveIndex(null);
  }

  return (
    <div className="account-chart">
      <div className="account-range-row" role="tablist" aria-label="Account profit and loss period">
        {RANGES.map((option) => {
          const active = option === range;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`Chart ${RANGE_CONFIG[option].label}`}
              onClick={() => onRangeChange(option)}
              className={`account-range-btn pressable ${active ? "is-active" : ""}`}
            >
              {RANGE_CONFIG[option].tab}
            </button>
          );
        })}
        <span className="account-range-unit">P/L</span>
      </div>

      <div
        className="account-chart-canvas mt-4"
        role="img"
        aria-label={`Account profit and loss over ${RANGE_CONFIG[range].label}`}
      >
        <ActiveValueLabel point={activePoint} currency={currency} />
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={series}
            // Match Signals: fill continues beneath the line to the chart's
            // lower edge, then fades out. Zero remains only a reference rule.
            baseValue={min - room}
            margin={{ top: 14, right: 4, left: 4, bottom: 4 }}
            onMouseMove={handleChartFocus}
            onMouseLeave={() => setActiveIndex(null)}
            onTouchStart={handleChartFocus}
            onTouchMove={handleChartFocus}
            onTouchEnd={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.45} />
            <XAxis
              dataKey="axisLabel"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              interval={tickInterval}
            />
            <YAxis hide domain={[min - room, max + room]} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke, strokeWidth: 1, strokeDasharray: "4 4", strokeOpacity: 0.55 }}
              content={(props: {
                active?: boolean;
                payload?: readonly TooltipPayloadItem[];
              }) => (
                <AccountChartTooltip
                  active={props.active}
                  payload={props.payload}
                  currency={currency}
                />
              )}
            />
            <ReferenceLine
              y={0}
              stroke="var(--border-strong, var(--border))"
              strokeWidth={1}
              ifOverflow="extendDomain"
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={stroke}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              dot={false}
              activeDot={(props: { cx?: number; cy?: number; payload?: AccountChartPoint }) => (
                <PnLDot cx={props.cx} cy={props.cy} payload={props.payload} radius={5} />
              )}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[color:var(--muted)]">
        <span>
          {movementCount
            ? `${movementCount} broker P/L ${movementCount === 1 ? "change" : "changes"}`
            : "No closed P/L changes"}
        </span>
        <span className={netChange >= 0 ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>
          {netChange >= 0 ? "+" : "−"}{moneyExact(Math.abs(netChange), currency)} over {RANGE_CONFIG[range].label}
        </span>
      </div>

      {/* Colour is not the only channel: the total and direction remain spoken. */}
      <p className="sr-only">
        Account P/L {netChange >= 0 ? "up" : "down"}{" "}
        {moneyCompact(Math.abs(netChange), currency)} over {RANGE_CONFIG[range].label}.
      </p>
    </div>
  );
}
