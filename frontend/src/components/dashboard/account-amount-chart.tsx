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
import { formatDayAndTime } from "@/lib/format/datetime";
import type { AccountBalanceHistoryPoint } from "@/types/forex";

export type AccountChartPoint = {
  label: string;
  value: number;
  at: string;
  tradeNumber: number | null;
  tradePnl: number | null;
  /** Position on the axis: 0 is the balance before the window's first trade,
   *  then one step per closed trade, ending at now. */
  index: number;
};

/**
 * How much of the record to draw, counted in trades rather than in hours.
 *
 * Wall-clock windows do not suit this account. It trades in bursts of a few a
 * day and then sits still — so an hour and a day both drew flat lines with
 * nothing in them, a week and a month drew the identical fourteen trades, and
 * every view carried a dead flat tail from the last close to now. Three of the
 * four buttons showed nothing.
 *
 * Counting trades is also how an equity curve is normally read: the question is
 * "how did the last twenty-five go", not "how did Tuesday go".
 */
export type AccountChartRange = "10" | "25" | "50" | "all";

const RANGES: AccountChartRange[] = ["10", "25", "50", "all"];

const RANGE_TRADES: Record<AccountChartRange, number | null> = {
  "10": 10,
  "25": 25,
  "50": 50,
  all: null,
};

/** How the range reads in a sentence, article included so it composes. */
const RANGE_LABEL: Record<AccountChartRange, string> = {
  "10": "the last 10 trades",
  "25": "the last 25 trades",
  "50": "the last 50 trades",
  all: "all trades",
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

/**
 * Build an account-amount series ending at current NAV from closed paper P/L.
 *
 * One point per closed trade, plus the balance it started from and what the
 * account is worth right now. The steps are evenly spaced because the axis
 * counts trades, not hours — which removes the dead flat stretches that a real
 * time axis draws over the days and weekends when nothing traded.
 */
export function buildAccountAmountSeries({
  nav,
  unrealizedPL,
  history,
  range,
}: {
  nav: number;
  unrealizedPL: number;
  history: AccountBalanceHistoryPoint[];
  range: AccountChartRange;
}): AccountChartPoint[] {
  const now = Date.now();
  const closed = history
    .map((movement, index) => ({
      at: new Date(movement.time).getTime(),
      pl: movement.change,
      balance: movement.balance,
      tradeNumber: index + 1,
    }))
    .filter((movement) => Number.isFinite(movement.at) && Number.isFinite(movement.balance) && Number.isFinite(movement.pl))
    .sort((a, b) => a.at - b.at || a.tradeNumber - b.tradeNumber);

  const limit = RANGE_TRADES[range];
  const window = limit === null ? closed : closed.slice(-limit);

  const openedAt = window[0] ? new Date(window[0].at) : new Date(now);
  const openingBalance = window[0] ? window[0].balance - window[0].pl : nav - unrealizedPL;
  const points: AccountChartPoint[] = [
    {
      label: window.length ? `Before ${formatDayAndTime(openedAt)}` : "Opening balance",
      value: Number(openingBalance.toFixed(2)),
      at: openedAt.toISOString(),
      tradeNumber: window[0]?.tradeNumber === null || window[0]?.tradeNumber === undefined ? null : window[0].tradeNumber - 1,
      tradePnl: null,
      index: 0,
    },
  ];

  window.forEach((trade, position) => {
    points.push({
      label: formatDayAndTime(new Date(trade.at)),
      value: Number(trade.balance.toFixed(2)),
      at: new Date(trade.at).toISOString(),
      tradeNumber: trade.tradeNumber,
      tradePnl: trade.pl,
      index: position + 1,
    });
  });

  // Now, carrying any open trade's unrealised P/L. Always present, so the line
  // ends on the number the hero reports above it.
  points.push({
    label: "Now",
      value: Number(nav.toFixed(2)),
      at: new Date(now).toISOString(),
      tradeNumber: null,
      tradePnl: null,
      index: window.length + 1,
  });

  // With no closed trades at all this is two points — what the account settled
  // at and what it is worth now — drawn as the straight line that is the truth.
  //
  // It used to interpolate a six-point curve here to "keep the chart readable
  // when history is sparse". That drew a shape no trade produced, on the chart
  // reporting the account balance.
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
  return (series.at(-1)?.value ?? 0) >= (series[0]?.value ?? 0);
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
        {point.tradeNumber === null
          ? point.label
          : `Broker movement · ${point.tradePnl !== null && point.tradePnl >= 0 ? "+" : ""}${point.tradePnl === null ? "" : moneyExact(point.tradePnl, currency)}`}
      </span>
    </div>
  );
}

/**
 * A dot under the pointer, and a permanent one on the last point.
 *
 * Both carry a 2px ring in the surface colour so they stay legible where they
 * sit on the line rather than merging into it.
 */
function ChartDot({
  cx,
  cy,
  color,
  radius = 4,
}: {
  cx?: number;
  cy?: number;
  color: string;
  radius?: number;
}): ReactNode {
  if (cx === undefined || cy === undefined) return null;

  return (
    <circle
      cx={cx}
      cy={cy}
      r={radius}
      fill={color}
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
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Headroom above the peak, kept tighter than the room below so the curve sits
  // in the canvas rather than floating in the lower half of it.
  const headroom = Math.max((max - min) * 0.08, Math.abs(max) * 0.001, 0.5);
  const footroom = Math.max((max - min) * 0.16, Math.abs(max) * 0.002, 1);
  // The opening value of the window on screen, and the direction against it.
  //
  // This used to be the caller's `positive`, which is the day's P/L — so a flat
  // day painted a losing month green. The colour has to describe the period the
  // chart actually draws, or it contradicts the shape underneath it.
  const opening = series[0]?.value ?? 0;
  const latest = series.at(-1)?.value ?? 0;
  const stroke = accountSeriesRose(series) ? "var(--chart-up)" : "var(--chart-down)";
  const activePoint = activeIndex === null ? null : (series[activeIndex] ?? null);
  const lastIndex = series.length - 1;
  // The builder numbers its own points, opening at 0 and ending at now.
  const axisStart = series[0]?.index ?? 0;
  const axisEnd = series.at(-1)?.index ?? 1;
  const tradePoints = series.filter((point) => point.tradeNumber !== null && point.tradePnl !== null);
  const tradeStart = tradePoints[0]?.tradeNumber ?? null;
  const tradeEnd = tradePoints.at(-1)?.tradeNumber ?? null;
  const netChange = latest - opening;
  const ticks = Array.from(new Set([axisStart, Math.round((axisStart + axisEnd) / 2), axisEnd]));

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
        <div className="account-range-row" role="tablist" aria-label="How many broker movements to chart">
        {RANGES.map((option) => {
          const active = option === range;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`Chart ${RANGE_LABEL[option]}`}
              onClick={() => onRangeChange(option)}
              className={`account-range-btn pressable ${active ? "is-active" : ""}`}
            >
              {option === "all" ? "All" : option}
            </button>
          );
        })}
        <span className="account-range-unit">movements</span>
      </div>

      <div
        className="account-chart-canvas mt-4"
        role="img"
        aria-label={`Account amount over ${RANGE_LABEL[range]}`}
      >
        <ActiveValueLabel point={activePoint} currency={currency} />
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={series}
            // Right margin is the end dot's radius plus its ring: at 0 the dot
            // sits on the last pixel of the surface and gets sliced in half.
            margin={{ top: 14, right: 6, left: 0, bottom: 4 }}
            onMouseMove={handleChartFocus}
            onMouseLeave={() => setActiveIndex(null)}
            onTouchStart={handleChartFocus}
            onTouchMove={handleChartFocus}
            onTouchEnd={() => setActiveIndex(null)}
          >
            <defs>
              {/* A wash, not a block. The middle stop bends the falloff so the
                  fill fades out under the line instead of banding across it. */}
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.18} />
                <stop offset="55%" stopColor={stroke} stopOpacity={0.05} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.45} />

            {/* One step per trade. An explicit numeric domain rather than the
                default category spacing, so a range holding fewer trades than
                its name still spans the full width. */}
            <XAxis
              type="number"
              dataKey="index"
              domain={[axisStart, axisEnd]}
              ticks={ticks}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              tickFormatter={(index: number) => {
                const point = series.find((item) => item.index === index);
                if (!point || point.tradeNumber === null) return point?.label === "Now" ? "Now" : "Start";
                return `A${point.tradeNumber}`;
              }}
            />
            <YAxis hide domain={[min - footroom, max + headroom]} />
            <Tooltip
              isAnimationActive={false}
              cursor={{
                stroke,
                strokeWidth: 1,
                strokeDasharray: "4 4",
                strokeOpacity: 0.55,
              }}
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
            {/* Where the window opened. Without it the curve floats: you can
                see the shape but not whether it ends up or down on the period.
                Solid hairline in the border token — a rule, not a series. */}
            <ReferenceLine
              y={opening}
              stroke="var(--border-strong, var(--border))"
              strokeWidth={1}
              ifOverflow="extendDomain"
            />
            {/* Monotone rather than a plain spline: it eases through each close
                without overshooting, so the line never bulges to a balance the
                account did not hold. Safe to curve now that the axis counts
                trades — the evenly spaced points leave no near-vertical runs
                for a curve to flare into. */}
            <Area
              type="stepAfter"
              dataKey="value"
              stroke={stroke}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              activeDot={(props: { cx?: number; cy?: number }) => (
                <ChartDot cx={props.cx} cy={props.cy} color={stroke} radius={5} />
              )}
              // Only the last point is marked, so the eye lands on "now"
              // without a dot on every trade turning the line into beads.
              dot={(props: { cx?: number; cy?: number; index?: number; payload?: AccountChartPoint }) => {
                const point = props.payload;
                if (props.index === lastIndex) return <ChartDot cx={props.cx} cy={props.cy} color={stroke} />;
                if (point?.tradePnl === null || point?.tradePnl === undefined) return <g />;
                return <ChartDot cx={props.cx} cy={props.cy} color={point.tradePnl >= 0 ? "var(--success)" : "var(--danger)"} radius={3.5} />;
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[color:var(--muted)]">
        <span>{tradePoints.length ? `${tradePoints.length} broker movements` : "No broker movements"}</span>
        <span className={netChange >= 0 ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>
          {netChange >= 0 ? "+" : "−"}{moneyExact(Math.abs(netChange), currency)} over {tradePoints.length} movements
        </span>
      </div>

      {/* The direction in words. The line carries it in colour, and colour is
          never allowed to be the only channel. */}
      <p className="sr-only">
        Account amount {moneyCompact(latest, currency)}, {latest >= opening ? "up" : "down"}{" "}
        {moneyCompact(Math.abs(latest - opening), currency)} over {RANGE_LABEL[range]}, from{" "}
        {moneyCompact(opening, currency)}.
      </p>
    </div>
  );
}
