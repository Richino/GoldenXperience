"use client";

import { useMemo, type ReactNode } from "react";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";

type ExperimentEquityPoint = {
  candidateId: string;
  decisionTime: string;
  resultR: number;
  cumulativeR: number;
  drawdownR: number;
};

type ChartPoint = {
  index: number;
  cumulativeR: number;
};

function buildChartData(points: ExperimentEquityPoint[]): ChartPoint[] {
  return [
    { index: 0, cumulativeR: 0 },
    ...points.map((point, index) => ({
      index: index + 1,
      cumulativeR: point.cumulativeR,
    })),
  ];
}

function renderEquityTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartPoint }>;
}) {
  if (!props.active || !props.payload?.length) return null;

  const point = props.payload[0]?.payload;
  if (!point || point.index === 0) return null;

  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-2.5 py-1.5 text-xs text-[color:var(--foreground)]">
      <span className="text-[color:var(--muted)]">Trade {point.index}</span>
      <span className="metric-number ml-2 font-medium">
        {point.cumulativeR >= 0 ? "+" : ""}
        {point.cumulativeR.toFixed(2)}R
      </span>
    </div>
  );
}

function EquityChartSkeleton() {
  return (
    <div
      className="equity-chart-skeleton flex h-48 items-end px-1 pb-1"
      aria-busy="true"
      aria-label="Loading equity chart"
    >
      <div className="equity-chart-skeleton-track h-full w-full" />
    </div>
  );
}

function EquityChartShell({ children }: { children: ReactNode }) {
  return <div className="equity-chart-shell">{children}</div>;
}

export function ExperimentEquityChart({
  series,
  loading = false,
}: {
  series: ExperimentEquityPoint[];
  loading?: boolean;
}) {
  const data = useMemo(() => buildChartData(series), [series]);
  const endingR = data.at(-1)?.cumulativeR ?? 0;
  const tone = endingR >= 0 ? "var(--accent)" : "var(--danger)";
  const values = data.map((point) => point.cumulativeR);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const padding = Math.max((max - min) * 0.12, 0.25);

  if (loading) {
    return (
      <EquityChartShell>
        <EquityChartSkeleton />
      </EquityChartShell>
    );
  }

  if (series.length === 0) {
    return (
      <EquityChartShell>
        <div
          className="flex h-48 items-center justify-center text-xs text-[color:var(--muted)]"
          role="img"
          aria-label="No experiment equity data"
        >
          No resolved trades in this experiment yet.
        </div>
      </EquityChartShell>
    );
  }

  return (
    <EquityChartShell>
      <div
        className="h-48 w-full"
        role="img"
        aria-label="Experiment cumulative R progression"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: 4, left: 0, bottom: 4 }}
          >
            <YAxis hide domain={[min - padding, max + padding]} />
            <ReferenceLine
              y={0}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <Tooltip
              cursor={false}
              content={renderEquityTooltip}
            />
            <Line
              type="monotone"
              dataKey="cumulativeR"
              stroke={tone}
              strokeWidth={1.5}
              dot={false}
              activeDot={{
                r: 3,
                fill: tone,
                stroke: "var(--surface)",
                strokeWidth: 1.5,
              }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </EquityChartShell>
  );
}
