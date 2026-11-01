import type { Candle } from "../../types/forex";
import { candleAligned, candleEnd } from "../strategy/candle-clock";
import { buildForecast, metrics, score } from "./engine";
import type { HistoryRow, Metric } from "./types";

/** Exact NY daily close only; never use the next available holiday candle. */
export function expiryCandle(candles: Candle[], expiresAt: string, now: number): Candle | null {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry > now) return null;
  return candles.find(b => b.complete && candleAligned(Date.parse(b.time), "D") && candleEnd(Date.parse(b.time), "D") === expiry
    && [b.open, b.high, b.low, b.close].every(v => Number.isFinite(v) && v > 0) && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)) ?? null;
}

export type ChronologicalValidation = { splitAt: string; development: Metric[]; holdout: Metric[]; purged: number; observations: number; note: string };

/** Reapply current rules to frozen snapshots without recalculating indicators
 * using future prices. No fitting or tuning occurs in this helper. */
export function chronologicalValidation(rows: HistoryRow[], splitAt: string, reapplyRules = false): ChronologicalValidation {
  const split = Date.parse(splitAt);
  if (!Number.isFinite(split)) throw new Error("A valid chronological split timestamp is required.");
  const eligible = rows.filter(r => r.snapshot.eligible && r.outcome);
  if (new Set(eligible.map(r => r.snapshot.modelVersion)).size > 1) throw new Error("Validate one frozen source model version at a time.");
  const unique = [...new Map(eligible.map(r => [r.id, r])).values()];
  const prepared = unique.map(r => {
    if (Object.values(r.snapshot.frames).some(f => Date.parse(f.lastCloseAt) > Date.parse(r.snapshot.createdAt))) throw new Error("Snapshot contains future candle data.");
    if (!reapplyRules) return r;
    const forecast = buildForecast(r.snapshot, r.forecast.horizon);
    return { ...r, forecast, outcome: { ...score(r.snapshot.referencePrice,forecast,r.outcome!.price,r.outcome!.at), baselineCorrect:r.outcome!.baselineCorrect } };
  });
  const development = prepared.filter(r => Date.parse(r.forecast.expiresAt) < split);
  const holdout = prepared.filter(r => Date.parse(r.snapshot.createdAt) >= split);
  return { splitAt: new Date(split).toISOString(), development: metrics(development), holdout: metrics(holdout),
    purged: prepared.length - development.length - holdout.length, observations: prepared.length,
    note: "Freeze rules using development data before inspecting holdout outcomes. Crossing forecasts are purged. Overlap counts remain reported by pair/horizon. Repeated tuning to this holdout invalidates its out-of-sample status. Accuracy is not profitability." };
}
