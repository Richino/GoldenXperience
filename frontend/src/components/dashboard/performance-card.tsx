"use client";

import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  YAxis,
} from "recharts";
import { SectionLabel } from "@/components/ui/section-label";
import type { JournalEquityPoint, JournalStats } from "@/lib/journal/stats";

type ChartPoint = {
  index: number;
  cumulativeR: number;
};

function buildChartData(equityCurve: JournalEquityPoint[]): ChartPoint[] {
  return [
    { index: 0, cumulativeR: 0 },
    ...equityCurve.map((point, index) => ({
      index: index + 1,
      cumulativeR: point.cumulativeR,
    })),
  ];
}

function EquityCurveChart({ series }: { series: JournalEquityPoint[] }) {
  const gradientId = useId().replace(/:/g, "");
  const data = useMemo(() => buildChartData(series), [series]);
  const positive = (data.at(-1)?.cumulativeR ?? 0) >= 0;
  const tone = positive ? "var(--success)" : "var(--danger)";
  const values = data.map((point) => point.cumulativeR);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const padding = Math.max((max - min) * 0.12, 0.25);

  return (
    <div className="relative h-28 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tone} stopOpacity={0.16} />
              <stop offset="100%" stopColor={tone} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[min - padding, max + padding]} />
          <ReferenceLine
            y={0}
            stroke="var(--border)"
            strokeDasharray="2 4"
            strokeWidth={1}
          />
          <Area
            type="monotone"
            dataKey="cumulativeR"
            stroke={tone}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={(props) => {
              const { cx, cy, index } = props;

              if (
                index !== data.length - 1 ||
                cx === undefined ||
                cy === undefined
              ) {
                return null;
              }

              return (
                <circle
                  cx={cx}
                  cy={cy}
                  r={3.5}
                  fill={tone}
                  stroke="var(--surface)"
                  strokeWidth={1.5}
                />
              );
            }}
            activeDot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PerformanceCard({ stats }: { stats: JournalStats }) {
  const hasData = stats.closedCount > 0;

  return (
    <section className="app-card p-5 md:p-6">
      <div className="flex items-end justify-between gap-4">
        <SectionLabel title="Performance" variant="minimal" />
        <div className="text-right">
          <div className="text-xs text-[color:var(--muted)]">Net R</div>
          <div
            className={`metric-number text-lg font-semibold tracking-[-0.03em] ${
              stats.netR >= 0
                ? "text-[color:var(--success)]"
                : "text-[color:var(--danger)]"
            }`}
          >
            {stats.netR >= 0 ? "+" : ""}
            {stats.netR.toFixed(2)}R
          </div>
        </div>
      </div>

      <div className="mt-4">
        {hasData ? (
          <EquityCurveChart series={stats.equityCurve} />
        ) : (
          <div className="dashboard-inset flex h-28 items-center justify-center text-xs text-[color:var(--muted)]">
            Log closed trades to build the equity curve.
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {[
          ["Win rate", `${stats.winRate.toFixed(0)}%`],
          [
            "Avg R",
            `${stats.averageR >= 0 ? "+" : ""}${stats.averageR.toFixed(2)}R`,
          ],
          ["Max DD", `-${stats.maxDrawdownR.toFixed(2)}R`],
        ].map(([label, value]) => (
          <div key={label} className="dashboard-inset px-3 py-2.5">
            <div className="text-xs text-[color:var(--muted)]">{label}</div>
            <div className="metric-number mt-1 text-sm font-medium">
              {value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
