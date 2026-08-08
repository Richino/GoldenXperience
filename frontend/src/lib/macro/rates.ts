import type { MajorInstrument } from "@/types/forex";

/**
 * Interest-rate backdrop per currency, read from FRED.
 *
 * No `server-only` guard, deliberately: the api-server imports this module
 * directly under tsx rather than through Next, and that guard throws outside
 * Next's runtime. It follows the same convention as the OANDA client, which is
 * server-side for the same reason and marks itself the same way — by reading
 * process env and never being imported from a client component.
 *
 * One series family is used for every currency — OECD long-term government
 * rates — even though FRED carries daily data for USD, EUR and GBP. Mixing
 * frequencies would be worse than useless: pairing a daily US yield against a
 * two-month-old Japanese monthly average makes the differential move whenever
 * the US series updates, which reads as a change in the macro backdrop when
 * nothing has changed. Consistency beats freshness here.
 *
 * What this measures is therefore structural — which currency pays more — and
 * it moves monthly. Rate *expectations*, the part that shifts week to week, are
 * invisible at this frequency and would need a different data source.
 */
const SERIES: Record<string, string> = {
  USD: "IRLTLT01USM156N",
  EUR: "IRLTLT01DEM156N",
  GBP: "IRLTLT01GBM156N",
  JPY: "IRLTLT01JPM156N",
  AUD: "IRLTLT01AUM156N",
  NZD: "IRLTLT01NZM156N",
  CAD: "IRLTLT01CAM156N",
  CHF: "IRLTLT01CHM156N",
};

/** Percentage points the differential must clear before it is called a bias. */
const BIAS_THRESHOLD = 0.2;
/** Monthly data refreshed once a day is already far more often than it moves. */
const CACHE_MS = 6 * 60 * 60 * 1000;

export type MacroBias = "long" | "short" | "neutral";

export interface MacroRead {
  bias: MacroBias;
  /** Base currency rate minus quote currency rate, in percentage points. */
  differential: number | null;
  baseRate: number | null;
  quoteRate: number | null;
  /** Month the underlying observations belong to, so staleness is visible. */
  asOf: string | null;
  connected: boolean;
  detail: string;
}

type Cached = { rates: Map<string, { value: number; date: string }>; fetchedAt: number };
let cache: Cached | null = null;
let inFlight: Promise<Cached> | null = null;

async function fetchSeries(seriesId: string, key: string) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=1`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`FRED ${seriesId} responded ${response.status}`);
  const payload = await response.json() as { observations?: Array<{ date: string; value: string }> };
  const observation = payload.observations?.[0];
  if (!observation || observation.value === ".") return null;
  const value = Number(observation.value);
  return Number.isFinite(value) ? { value, date: observation.date } : null;
}

async function loadRates(): Promise<Cached> {
  const key = process.env.FRED_API_KEY;
  if (!key) return { rates: new Map(), fetchedAt: Date.now() };

  const rates = new Map<string, { value: number; date: string }>();
  const entries = await Promise.all(
    Object.entries(SERIES).map(async ([currency, seriesId]) => {
      try {
        return [currency, await fetchSeries(seriesId, key)] as const;
      } catch {
        // One unreachable series must not blank the whole macro read.
        return [currency, null] as const;
      }
    }),
  );
  for (const [currency, observation] of entries) if (observation) rates.set(currency, observation);
  return { rates, fetchedAt: Date.now() };
}

/** Shared across concurrent evaluations so ten pairs cause one fetch, not ten. */
async function rates(): Promise<Cached> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  inFlight ??= loadRates().then((loaded) => { cache = loaded; inFlight = null; return loaded; });
  return inFlight;
}

export function currenciesOf(instrument: MajorInstrument) {
  const [base, quote] = instrument.split("_");
  return { base: base ?? "", quote: quote ?? "" };
}

/**
 * Minutes until the next high-impact release that could move this pair, or null
 * when none is scheduled.
 *
 * Filtered to the pair's own two currencies. The calendar snapshot reports the
 * next high-impact event anywhere, which would hold EUR_USD out of the market
 * for an Australian print that cannot move it.
 */
export function highImpactMinutesFor(
  instrument: MajorInstrument,
  events: Array<{ currency: string; impact: number; timestamp: string }>,
  now = new Date(),
) {
  const { base, quote } = currenciesOf(instrument);
  const relevant = events
    .filter((event) => event.currency === base || event.currency === quote)
    .filter((event) => event.impact >= HIGH_IMPACT_IMPACT)
    .map((event) => Math.round((Date.parse(event.timestamp) - now.getTime()) / 60_000))
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0)
    .sort((left, right) => left - right);
  return relevant[0] ?? null;
}

/** Mirrors the calendar module's own definition of high impact. */
const HIGH_IMPACT_IMPACT = 3;

/**
 * The macro read for one pair. Never throws: an unreachable FRED, a missing key
 * or a gap in one currency's series all resolve to a neutral, clearly-labelled
 * result, because a scoring factor that cannot be read should cost the setup
 * its point rather than the trade.
 */
export async function macroBiasFor(instrument: MajorInstrument): Promise<MacroRead> {
  const { base, quote } = currenciesOf(instrument);
  const loaded = await rates();

  if (!process.env.FRED_API_KEY) {
    return { bias: "neutral", differential: null, baseRate: null, quoteRate: null, asOf: null, connected: false, detail: "FRED_API_KEY is not configured." };
  }

  const baseRate = loaded.rates.get(base);
  const quoteRate = loaded.rates.get(quote);
  if (!baseRate || !quoteRate) {
    return { bias: "neutral", differential: null, baseRate: baseRate?.value ?? null, quoteRate: quoteRate?.value ?? null, asOf: null, connected: false, detail: `Rates unavailable for ${!baseRate ? base : quote}.` };
  }

  const differential = baseRate.value - quoteRate.value;
  const bias: MacroBias = differential >= BIAS_THRESHOLD ? "long" : differential <= -BIAS_THRESHOLD ? "short" : "neutral";
  const asOf = baseRate.date < quoteRate.date ? baseRate.date : quoteRate.date;

  return {
    bias,
    differential,
    baseRate: baseRate.value,
    quoteRate: quoteRate.value,
    asOf,
    connected: true,
    detail: `${base} ${baseRate.value.toFixed(2)}% vs ${quote} ${quoteRate.value.toFixed(2)}% · ${differential >= 0 ? "+" : ""}${differential.toFixed(2)} points as of ${asOf}`,
  };
}
