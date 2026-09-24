import type { AccountBalanceHistoryPoint } from '@/types/api';
import { startOfTradingDay } from '@/lib/time';

export type AccountChartRange = '1d' | '1w' | '1m' | '3m' | '1y';

export const RANGES: AccountChartRange[] = ['1d', '1w', '1m', '3m', '1y'];
export const RANGE_TABS: Record<AccountChartRange, string> = {
  '1d': '1D',
  '1w': '1W',
  '1m': '1M',
  '3m': '3M',
  '1y': '1Y',
};

const RANGE_CONFIG: Record<AccountChartRange, { durationMs: number; bucketMs: number }> = {
  '1d': { durationMs: 24 * 60 * 60_000, bucketMs: 60 * 60_000 },
  '1w': { durationMs: 7 * 24 * 60 * 60_000, bucketMs: 6 * 60 * 60_000 },
  '1m': { durationMs: 30 * 24 * 60 * 60_000, bucketMs: 24 * 60 * 60_000 },
  '3m': { durationMs: 90 * 24 * 60 * 60_000, bucketMs: 2 * 24 * 60 * 60_000 },
  '1y': { durationMs: 365 * 24 * 60 * 60_000, bucketMs: 7 * 24 * 60 * 60_000 },
};

export type AccountChartPoint = {
  axisLabel: string;
  value: number;
  change: number;
  index: number;
};

function rangeCutoff(range: AccountChartRange, now: number) {
  if (range === '1d') return startOfTradingDay(now).getTime();
  return now - RANGE_CONFIG[range].durationMs;
}

function formatAxisTick(value: number, range: AccountChartRange) {
  const date = new Date(value);
  switch (range) {
    case '1d':
      return new Intl.DateTimeFormat('en-US', { hour: 'numeric' }).format(date);
    case '1w':
      return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
    case '1m':
    case '3m':
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
    case '1y':
      return new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' }).format(date);
    default:
      return '';
  }
}

/**
 * Build an account-value curve from broker-reported P/L. Ported from
 * frontend/src/components/dashboard/account-amount-chart.tsx, trimmed to the
 * fields the mobile chart draws (no tooltip payload, no bucket labels).
 */
export function buildAccountAmountSeries({
  nav,
  unrealizedPL,
  history,
  range,
  now = Date.now(),
}: {
  nav: number;
  unrealizedPL: number;
  history: AccountBalanceHistoryPoint[];
  range: AccountChartRange;
  now?: number;
}): AccountChartPoint[] {
  const config = RANGE_CONFIG[range];
  const cutoff = rangeCutoff(range, now);
  const spanMs = Math.max(now - cutoff, config.bucketMs);
  const bucketCount = Math.max(1, Math.ceil(spanMs / config.bucketMs));
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = cutoff + index * config.bucketMs;
    const end = Math.min(start + config.bucketMs, now);
    return {
      axisLabel: formatAxisTick(start + (end - start) / 2, range),
      change: 0,
      index,
    };
  });

  const movements = history
    .map((movement) => ({ at: new Date(movement.time).getTime(), pl: movement.change }))
    .filter((movement) => Number.isFinite(movement.at) && movement.at >= cutoff && movement.at <= now && Number.isFinite(movement.pl))
    .sort((a, b) => a.at - b.at);

  for (const movement of movements) {
    const bucketIndex = Math.min(Math.floor((movement.at - cutoff) / config.bucketMs), bucketCount - 1);
    const point = buckets[bucketIndex];
    if (!point) continue;
    point.change += movement.pl;
  }

  const realizedPeriodPL = buckets.reduce((sum, point) => sum + point.change, 0);
  const openingValue = nav - realizedPeriodPL - unrealizedPL;
  let runningValue = openingValue;
  const points: AccountChartPoint[] = [
    { axisLabel: formatAxisTick(cutoff, range), value: Number(openingValue.toFixed(2)), change: 0, index: 0 },
  ];

  buckets.forEach((bucket, index) => {
    const isLast = index === buckets.length - 1;
    const change = bucket.change + (isLast ? unrealizedPL : 0);
    runningValue += change;
    points.push({
      axisLabel: bucket.axisLabel,
      change: Number(change.toFixed(2)),
      value: Number((isLast ? nav : runningValue).toFixed(2)),
      index: index + 1,
    });
  });

  return points;
}

export type AccountSeriesTone = 'up' | 'down' | 'flat';
const FLAT_CASH = 1;

export function accountSeriesTone(series: AccountChartPoint[]): AccountSeriesTone {
  const opening = series[0]?.value ?? 0;
  const latest = series.at(-1)?.value ?? opening;
  const net = latest - opening;
  if (Math.abs(net) < FLAT_CASH) return 'flat';
  return net > 0 ? 'up' : 'down';
}
