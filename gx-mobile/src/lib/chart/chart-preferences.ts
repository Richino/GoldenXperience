import { getItem, setItem } from '@/lib/storage';

const STORAGE_KEY = 'gx-mobile.chart-preferences.v1';

export type SavedChartTimeframe = '1m' | '5m' | '15m' | '1H' | '4H';
export type SavedChartRange = '1D' | '1W' | '1M' | '3M' | '1Y';
export type SavedChartVariant = 'candle' | 'hollow' | 'heikin' | 'bar' | 'line' | 'area' | 'baseline';

export type SavedChartPreferences = {
  timeframe: SavedChartTimeframe;
  range: SavedChartRange;
  variant: SavedChartVariant;
  indicators: string[];
  /** Last pair opened on the Chart tab; reopened when no pair is requested. */
  instrument?: string;
};

const DEFAULTS: SavedChartPreferences = {
  timeframe: '15m',
  range: '1D',
  variant: 'area',
  indicators: [],
};

function validTimeframe(value: unknown): value is SavedChartTimeframe {
  return value === '1m' || value === '5m' || value === '15m' || value === '1H' || value === '4H';
}

function validRange(value: unknown): value is SavedChartRange {
  return value === '1D' || value === '1W' || value === '1M' || value === '3M' || value === '1Y';
}

function validVariant(value: unknown): value is SavedChartVariant {
  return value === 'candle' || value === 'hollow' || value === 'heikin' || value === 'bar' || value === 'line' || value === 'area' || value === 'baseline';
}

export async function loadChartPreferences(): Promise<SavedChartPreferences> {
  try {
    const raw = await getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SavedChartPreferences>;
    return {
      timeframe: validTimeframe(parsed.timeframe) ? parsed.timeframe : DEFAULTS.timeframe,
      range: validRange(parsed.range) ? parsed.range : DEFAULTS.range,
      variant: validVariant(parsed.variant) ? parsed.variant : DEFAULTS.variant,
      indicators: Array.isArray(parsed.indicators) ? parsed.indicators.filter((item) => typeof item === 'string') : [],
      instrument: typeof parsed.instrument === 'string' ? parsed.instrument : undefined,
    };
  } catch {
    return DEFAULTS;
  }
}

export async function saveChartPreferences(preferences: SavedChartPreferences): Promise<void> {
  await setItem(STORAGE_KEY, JSON.stringify(preferences));
}
