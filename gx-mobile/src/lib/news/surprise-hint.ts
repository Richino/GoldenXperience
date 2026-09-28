/** Mirrors frontend/src/lib/news/surprise-hint.ts for the native Home card. */

export type TrendDirection = 'up' | 'down';

export type NewsSurpriseHint =
  | { kind: 'unknown' }
  | {
      kind: 'before';
      beatDirection: TrendDirection;
      missDirection: TrendDirection;
    }
  | {
      kind: 'after';
      outcome: 'beat' | 'miss' | 'inline';
      direction: TrendDirection | 'flat';
    };

const TITLE_POLARITY: Array<{ match: string; polarity: 1 | -1 }> = [
  { match: 'non-farm', polarity: 1 },
  { match: 'non farm', polarity: 1 },
  { match: 'employment change', polarity: 1 },
  { match: 'unemployment rate', polarity: -1 },
  { match: 'jobless claims', polarity: -1 },
  { match: 'cpi', polarity: 1 },
  { match: 'inflation', polarity: 1 },
  { match: 'pce', polarity: 1 },
  { match: 'ppi', polarity: 1 },
  { match: 'retail sales', polarity: 1 },
  { match: 'gdp', polarity: 1 },
  { match: 'pmi', polarity: 1 },
  { match: 'consumer confidence', polarity: 1 },
  { match: 'interest rate', polarity: 1 },
  { match: 'cash rate', polarity: 1 },
  { match: 'official bank rate', polarity: 1 },
  { match: 'policy rate', polarity: 1 },
];

const SKIP_TITLE = /speech|speaks|press conference|meeting minutes|bank holiday|holiday/i;

function eventCurrencyPolarity(title: string): 1 | -1 | null {
  if (SKIP_TITLE.test(title)) return null;
  const lower = title.toLowerCase();
  for (const rule of TITLE_POLARITY) {
    if (lower.includes(rule.match)) return rule.polarity;
  }
  return null;
}

function parseCalendarValue(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  let s = raw.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!s || s === '—' || s === '-') return null;
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1);
  }
  const suffix = s.slice(-1).toUpperCase();
  let multiplier = 1;
  if (suffix === 'K') {
    multiplier = 1_000;
    s = s.slice(0, -1);
  } else if (suffix === 'M') {
    multiplier = 1_000_000;
    s = s.slice(0, -1);
  } else if (suffix === 'B') {
    multiplier = 1_000_000_000;
    s = s.slice(0, -1);
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return value * multiplier * (percent ? 0.01 : 1);
}

export function newsSurpriseHint(event: {
  title: string;
  forecast?: string | null;
  previous?: string | null;
  actual?: string | null;
}): NewsSurpriseHint {
  const polarity = eventCurrencyPolarity(event.title);
  if (polarity === null) return { kind: 'unknown' };

  const forecast = parseCalendarValue(event.forecast ?? null);
  const actual = parseCalendarValue(event.actual ?? null);

  if (actual !== null && forecast !== null) {
    const delta = actual - forecast;
    const epsilon = Math.max(Math.abs(forecast) * 0.001, 1e-9);
    const outcome = delta > epsilon ? 'beat' : delta < -epsilon ? 'miss' : 'inline';
    if (outcome === 'inline') {
      return { kind: 'after', outcome, direction: 'flat' };
    }
    const surpriseSign = outcome === 'beat' ? 1 : -1;
    const direction: TrendDirection = polarity * surpriseSign > 0 ? 'up' : 'down';
    return { kind: 'after', outcome, direction };
  }

  const beatDirection: TrendDirection = polarity > 0 ? 'up' : 'down';
  const missDirection: TrendDirection = polarity > 0 ? 'down' : 'up';
  return { kind: 'before', beatDirection, missDirection };
}
