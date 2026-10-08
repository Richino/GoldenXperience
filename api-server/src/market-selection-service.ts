import { getCandles, getPricing, getSupportedForexInstruments } from "../../frontend/src/lib/oanda/client.js";
import { getMarketSelectionCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { isKnownInstrument, pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { computeSessionTradability, MARKET_SELECTION_POLICY, NY_TRADABILITY_CONFIG, TRADABILITY_H1_CANDLES, TRADABILITY_M15_CANDLES, tradabilityPhase,
  type MarketSelectionPolicy, type TradabilitySnapshot, type TradabilityQuote } from "../../frontend/src/lib/strategy/ny-tradability.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import { localMinutes, NEW_YORK_TIME_ZONE } from "../../frontend/src/lib/strategy/session.js";
import { TRACKED_CURRENCIES } from "../../frontend/src/lib/calendar/normalize.js";
import { query } from "./database.js";

const candleCache = new Map<string, { expires: number; value: Promise<Candle[] | null> }>();
let universe: { expires: number; names: string[] } | null = null;
let discovery: Promise<string[]> | null = null;
export function forexUniverse(instruments: Array<{ name: string; type?: string; pipLocation: number }>) {
  return [...new Set(instruments.filter(i => (!i.type || i.type === "CURRENCY") && isKnownInstrument(i.name)
    && Math.abs(pipSizeFor(i.name) - 10 ** i.pipLocation) < 1e-10).map(i => i.name))].sort();
}
export async function discoverSelectionInstruments(signal?: AbortSignal) {
  if (universe && universe.expires > Date.now()) return universe.names;
  discovery ??= getSupportedForexInstruments(signal).then(instruments => {
    const names = forexUniverse(instruments);
    if (!names.length) throw new Error("Broker returned no GX-supported currency instruments.");
    universe = { expires: Date.now() + 24 * 60 * 60_000, names };
    return names;
  }).finally(() => { discovery = null; });
  return discovery;
}

/** Four workers cap combined candle requests at eight; retry read failures only. */
export async function selectionMap<T, R>(values: T[], fn: (value: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  let index = 0;
  const output: R[] = new Array(values.length);
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (index < values.length) {
      signal?.throwIfAborted();
      const next = index++;
      output[next] = await fn(values[next]!);
    }
  }));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return output;
}
async function liveCandles(instrument: string, timeframe: string, count: number, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const value = await getCandles(instrument as MajorInstrument, timeframe, count, { signal });
    if (value.status.state === "connected" && value.data.source === "oanda") return value.data.candles;
    if (!/429|50[0234]|timed out|could not be reached/i.test(value.status.message) || attempt === 2) return null;
    await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
  }
  return null;
}
function cachedCandles(instrument: string, timeframe: "M15" | "H1", signal?: AbortSignal) {
  const now = Date.now();
  const key = `${instrument}:${timeframe}`;
  const hit = candleCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const duration = timeframe === "M15" ? 900_000 : 3_600_000;
  const value = liveCandles(instrument, timeframe, timeframe === "M15" ? TRADABILITY_M15_CANDLES : TRADABILITY_H1_CANDLES, signal);
  // Refresh at the first request after each close; the scheduled run's :00
  // close can use the preceding candle and the :05 run picks up the new bar.
  candleCache.set(key, { expires: Math.floor(now / duration) * duration + duration + 5_000, value });
  void value.then(result => { if (!result) candleCache.delete(key); }, () => candleCache.delete(key));
  return value;
}
async function candles(instrument: string, signal?: AbortSignal) {
  const [m15, h1] = await Promise.all([cachedCandles(instrument, "M15", signal), cachedCandles(instrument, "H1", signal)]);
  return { m15, h1 };
}
let pricingCache: { key: string; expires: number; value: Promise<Map<string, TradabilityQuote>> } | null = null;
async function quotes(instruments: string[], signal?: AbortSignal) {
  const key = [...instruments].sort().join(",");
  if (pricingCache?.key === key && pricingCache.expires > Date.now()) return pricingCache.value;
  const value = (async () => {
    const result = new Map<string, TradabilityQuote>();
    for (let start = 0; start < instruments.length; start += 40) {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        const read = await getPricing(instruments.slice(start, start + 40) as MajorInstrument[], { signal });
        if (read.status.state === "connected" && read.status.source === "oanda") {
          for (const q of read.data) if (q.source === "oanda") result.set(q.instrument, { bid: q.bid, ask: q.ask, time: q.time, tradeable: q.status === "tradeable" });
          break;
        }
        if (!/429|50[0234]|timed out|could not be reached/i.test(read.status.message) || attempt === 2) break;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    return result;
  })();
  pricingCache = { key, expires: Date.now() + 5_000, value };
  return value;
}

function policies(): Record<string, Partial<MarketSelectionPolicy>> {
  const raw = process.env.MORNING_SCAN_INSTRUMENT_POLICIES;
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MORNING_SCAN_INSTRUMENT_POLICIES must be an instrument-keyed JSON object.");
  return parsed as Record<string, Partial<MarketSelectionPolicy>>;
}
export function selectionPolicy(instrument: string): MarketSelectionPolicy {
  const override = policies()[instrument];
  if (override && Object.keys(override).some(k => !(k in MARKET_SELECTION_POLICY))) throw new Error("Unknown market selection policy field.");
  const policy = { ...MARKET_SELECTION_POLICY, ...override };
  for (const [key, value] of Object.entries(policy)) {
    if (key === "requireNews") { if (typeof value !== "boolean") throw new Error("Invalid requireNews policy."); }
    else if (key === "weights") {
      if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== Object.keys(MARKET_SELECTION_POLICY.weights).sort().join(",") || Object.values(value).some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0)
        || Math.abs(Object.values(value).reduce((a: number, b) => a + Number(b), 0) - 100) > 0.001) throw new Error("Ranking weights must sum to 100.");
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid selection policy: ${key}.`);
  }
  if (!(policy.objectivePips > 0)) throw new Error("objectivePips must be positive.");
  return policy;
}

const persistedClose = new Map<string, number>();
async function persistSelectionInputs(instruments: string[], history: Array<{ m15: Candle[] | null; h1: Candle[] | null }>, pricing: Map<string, TradabilityQuote>, cutoff: number, signal?: AbortSignal) {
  await selectionMap(instruments, async instrument => {
    const bars = history[instruments.indexOf(instrument)]!;
    for (const [timeframe, data, duration] of [["M15", bars.m15, 900_000], ["H1", bars.h1, 3_600_000]] as const) {
      signal?.throwIfAborted();
      const key = `${instrument}:${timeframe}`;
      const lastSaved = persistedClose.get(key) ?? 0;
      const rows = (data ?? []).filter(b => b.complete && Date.parse(b.time)+duration <= cutoff && Date.parse(b.time)+duration > lastSaved)
        .map(b => ({ close_time: new Date(Date.parse(b.time)+duration).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      if (!rows.length) continue;
      await query(`INSERT INTO market_candles(instrument,timeframe,close_time,open,high,low,close,volume,source)
        SELECT $1,$2,r.close_time,r.open,r.high,r.low,r.close,r.volume,'oanda'
        FROM jsonb_to_recordset($3::jsonb) AS r(close_time timestamptz,open numeric,high numeric,low numeric,close numeric,volume bigint)
        ON CONFLICT(instrument,timeframe,close_time,source) DO NOTHING`, [instrument,timeframe,JSON.stringify(rows)]);
      persistedClose.set(key,Math.max(...rows.map(r=>Date.parse(r.close_time))));
    }
    const q = pricing.get(instrument);
    if (q && [q.bid,q.ask].every(Number.isFinite) && q.ask > q.bid && q.bid > 0 && Date.parse(q.time) <= cutoff) {
      await query("INSERT INTO quote_snapshots(instrument,observed_at,bid,ask,spread_pips,source) VALUES($1,$2,$3,$4,$5,'oanda')", [instrument,q.time,q.bid,q.ask,(q.ask-q.bid)/pipSizeFor(instrument)]);
    }
  },signal);
}
export async function evaluateSelection(instruments: string[], signal?: AbortSignal, persistInputs = false) {
  const history = await selectionMap(instruments, i => candles(i, signal), signal);
  // Prices and news are read AFTER history, so they are fresh at evaluation.
  const [pricing, calendar] = await Promise.all([quotes(instruments, signal), getMarketSelectionCalendar().catch(() => null)]);
  signal?.throwIfAborted();
  const now = new Date(Date.now());
  // The current-week feed must cover the intended morning, not merely now.
  const news = calendar && Date.parse(calendar.coverageUntil) >= now.getTime() + Math.max(0, 660 - localMinutes(now, NEW_YORK_TIME_ZONE)) * 60_000 ? calendar.events : null;
  const pairs = instruments.map((instrument, i) => computeSessionTradability({ instrument, now, ...history[i]!, quote: pricing.get(instrument) ?? null,
    news: instrument.split("_").every(c => TRACKED_CURRENCIES.has(c)) ? news : null }, NY_TRADABILITY_CONFIG, selectionPolicy(instrument)));
  if (persistInputs) await persistSelectionInputs(instruments, history, pricing, now.getTime(), signal);
  return { pairs, evaluatedAt: now.toISOString(), newsFetchedAt: calendar?.fetchedAt ?? null, newsCoverageUntil: calendar?.coverageUntil ?? null };
}
export async function nyTradability(instruments: string[]): Promise<TradabilitySnapshot> {
  const phase = tradabilityPhase(new Date());
  if (phase === "outside") return { evaluatedAt: new Date().toISOString(), phase, session: "New York", newsAvailable: false,
    pairs: instruments.map(instrument => computeSessionTradability({ instrument, now: new Date(), m15: null, h1: null, quote: null, news: null })) };
  const result = await evaluateSelection(instruments);
  return { evaluatedAt: result.evaluatedAt, phase, session: "New York", newsAvailable: result.pairs.every(p => p.selection?.news.state === "KNOWN"), pairs: result.pairs };
}
