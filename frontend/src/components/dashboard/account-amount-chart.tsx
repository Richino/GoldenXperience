"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type AccountChartPoint = {
  label: string;
  value: number;
  at: string;
};

export type AccountChartRange = "1h" | "24h" | "1w" | "1m";

const RANGES: AccountChartRange[] = ["1h", "24h", "1w", "1m"];

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

function rangeMs(range: AccountChartRange) {
  switch (range) {
    case "1h":
      return 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "1w":
      return 7 * 24 * 60 * 60 * 1000;
    case "1m":
      return 30 * 24 * 60 * 60 * 1000;
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

function labelFor(date: Date, range: AccountChartRange) {
  switch (range) {
    case "1h":
      return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
    case "24h":
      return new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(date);
    case "1w":
      return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
    case "1m":
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

/** Build an account-amount series ending at current NAV from closed paper P/L. */
export function buildAccountAmountSeries({
  nav,
  unrealizedPL,
  trades,
  range,
}: {
  nav: number;
  unrealizedPL: number;
  trades: Array<{ paperPl: number | null; closedAt: string | null; openedAt: string; status: string }>;
  range: AccountChartRange;
}): AccountChartPoint[] {
  const now = Date.now();
  const start = now - rangeMs(range);
  const closed = trades
    .filter((trade) => trade.status !== "open" && trade.paperPl !== null && trade.closedAt)
    .map((trade) => ({
      at: new Date(trade.closedAt as string).getTime(),
      pl: trade.paperPl as number,
    }))
    .filter((trade) => trade.at >= start && trade.at <= now)
    .sort((a, b) => a.at - b.at);

  const settledNav = nav - unrealizedPL;
  const periodPl = closed.reduce((sum, trade) => sum + trade.pl, 0);
  let running = settledNav - periodPl;

  const points: AccountChartPoint[] = [
    {
      label: labelFor(new Date(start), range),
      value: Number(running.toFixed(2)),
      at: new Date(start).toISOString(),
    },
  ];

  for (const trade of closed) {
    running += trade.pl;
    points.push({
      label: labelFor(new Date(trade.at), range),
      value: Number(running.toFixed(2)),
      at: new Date(trade.at).toISOString(),
    });
  }

  points.push({
    label: labelFor(new Date(now), range),
    value: Number(nav.toFixed(2)),
    at: new Date(now).toISOString(),
  });

  // Keep the chart readable when history is sparse.
  if (points.length < 3) {
    const steps = range === "1h" ? 6 : range === "24h" ? 7 : range === "1w" ? 7 : 8;
    const baseline = settledNav - periodPl;
    const synthetic: AccountChartPoint[] = [];
    for (let index = 0; index < steps; index += 1) {
      const t = start + ((now - start) * index) / (steps - 1);
      const progress = index / (steps - 1);
      const value = baseline + periodPl * progress + unrealizedPL * Math.max(0, (progress - 0.85) / 0.15);
      synthetic.push({
        label: labelFor(new Date(t), range),
        value: Number(value.toFixed(2)),
        at: new Date(t).toISOString(),
      });
    }
    synthetic[synthetic.length - 1] = {
      label: labelFor(new Date(now), range),
      value: Number(nav.toFixed(2)),
      at: new Date(now).toISOString(),
    };
    return synthetic;
  }

  return points;
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
      {moneyExact(point.value, currency).replace(/^\$/, "")}
    </div>
  );
}

function ChartActiveDot({
  cx,
  cy,
}: {
  cx?: number;
  cy?: number;
}): ReactNode {
  if (cx === undefined || cy === undefined) return null;

  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill="var(--accent)"
      stroke="var(--background)"
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
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.18, Math.abs(max) * 0.002, 1);
  const stroke = "var(--accent)";
  const activePoint = activeIndex === null ? null : (series[activeIndex] ?? null);

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
      <div className="account-range-row" role="tablist" aria-label="Account chart range">
        {RANGES.map((option) => {
          const active = option === range;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onRangeChange(option)}
              className={`account-range-btn pressable ${active ? "is-active" : ""}`}
            >
              {option}
            </button>
          );
        })}
      </div>

      <div
        className="account-chart-canvas mt-4"
        role="img"
        aria-label={`Account amount over ${range}`}
      >
        <ActiveValueLabel point={activePoint} currency={currency} />
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={series}
            margin={{ top: 28, right: 0, left: 0, bottom: 4 }}
            onMouseMove={handleChartFocus}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="transparent" />

            <YAxis hide domain={[min - padding, max + padding]} />
            <Tooltip cursor={false} content={() => null} />
            <Area
              type="monotone"
              dataKey="value"
              stroke={stroke}
              strokeWidth={2.4}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              activeDot={ChartActiveDot}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p className="sr-only">
        Latest account amount {moneyCompact(series.at(-1)?.value ?? 0, currency)}.
      </p>
    </div>
  );
}
