import { calculateAbsorption, parseAbsorptionSettings } from "../../frontend/src/lib/indicators/absorption.js";
import { candleEnd } from "../../frontend/src/lib/strategy/candle-clock.js";
import type { CandleSeries } from "../../frontend/src/types/forex.js";

/** Recompute from provider candles; client-supplied prices and scores are never trusted. */
export function verifiedAbsorptionAlerts(series: CandleSeries, settings: unknown, requested: string[], now = Date.now()) {
  if (series.source !== "oanda") return [];
  const completed = series.candles.filter(c => c.complete).slice(-2).map(c => c.time);
  const ids = new Set(requested);
  return calculateAbsorption(series.candles, series.instrument, series.granularity, parseAbsorptionSettings(settings)).events
    .filter(event => ids.has(event.id) && completed.includes(event.time)
      && now >= candleEnd(Date.parse(event.time), series.granularity)
      && now - candleEnd(Date.parse(event.time), series.granularity) <= 2 * 3_600_000)
    .map(event => ({
      dedupeKey: event.id, kind: "setup_ready" as const, instrument: event.instrument, paperTradeId: null,
      title: `GX Absorption · ${event.direction} ${event.phase}`,
      message: `${event.instrument.replace("_", "/")} · ${event.timeframe} · ${event.direction} ${event.phase} · at ${new Date(candleEnd(Date.parse(event.time), series.granularity)).toISOString()} · candle ${event.time} · close ${event.price} · strength ${event.score}/100 (heuristic)`,
      url: `/chart?instrument=${encodeURIComponent(event.instrument)}`,
    }));
}
