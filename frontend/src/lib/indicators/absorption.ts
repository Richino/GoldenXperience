import type { Candle } from "@/types/forex";
import { candleEnd, intervalTraded } from "@/lib/strategy/candle-clock";

export const ABSORPTION_DEFAULTS = {
  relativeVolume: 1.5, volumeLookback: 20, structureLookback: 20, wickRatio: 0.4, bodyRatio: 0.5,
  minimumScore: 70, confirmationWindow: 4, minimumRangeAtr: 0.6, structureToleranceAtr: 0.25, projection: 24,
  showBullish: true, showBearish: true, showCandidates: true, showConfirmations: true, showScores: true,
};
export type AbsorptionSettings = typeof ABSORPTION_DEFAULTS;
export const ABSORPTION_RANGES: Record<string, [number, number, number]> = {
  relativeVolume: [0.1, 10, 0.1], volumeLookback: [2, 200, 1], structureLookback: [2, 200, 1],
  wickRatio: [0.05, 0.95, 0.05], bodyRatio: [0.05, 0.95, 0.05], minimumScore: [0, 100, 1],
  confirmationWindow: [1, 20, 1], minimumRangeAtr: [0.1, 5, 0.1], structureToleranceAtr: [0, 2, 0.05], projection: [1, 100, 1],
};
export function parseAbsorptionSettings(value: unknown): AbsorptionSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid absorption settings.");
  const result = { ...ABSORPTION_DEFAULTS };
  for (const key of Object.keys(result) as Array<keyof AbsorptionSettings>) {
    const next = (value as Record<string, unknown>)[key];
    if (next === undefined) continue;
    if (typeof result[key] === "boolean") {
      if (typeof next !== "boolean") throw new Error(`Invalid ${key}.`);
    } else {
      const [min, max, step] = ABSORPTION_RANGES[key];
      if (typeof next !== "number" || !Number.isFinite(next) || next < min || next > max || step === 1 && !Number.isInteger(next)) throw new Error(`Invalid ${key}.`);
    }
    Object.assign(result, { [key]: next });
  }
  return result;
}
export type AbsorptionStatus = "Candidate" | "Confirmed" | "Invalidated" | "Expired";
export type AbsorptionZone = {
  id: string; instrument: string; timeframe: string; direction: "bullish" | "bearish"; time: string; high: number; low: number;
  top: number; bottom: number; score: number; relativeVolume: number; wickRatio: number; bodyRatio: number; atr: number;
  support: number; resistance: number; status: AbsorptionStatus; confirmationPrice: number | null; confirmationTime: string | null;
  endedAt: string | null; reason: string | null; age: number;
};
export type AbsorptionEvent = { id: string; zoneId: string; instrument: string; timeframe: string; direction: AbsorptionZone["direction"]; phase: "candidate" | "confirmed"; time: string; price: number; score: number };
export type AbsorptionDiagnostic = { time: string; bullish: string[]; bearish: string[]; relativeVolume?: number; atr?: number; bodyRatio?: number; lowerWickRatio?: number; upperWickRatio?: number; support?: number; resistance?: number };
export function candleGeometry(c: Candle) {
  const range = c.high - c.low, body = Math.abs(c.close - c.open);
  return { range, body, bodyRatio: range > 0 ? body / range : 0, lowerWickRatio: range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0,
    upperWickRatio: range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0, closingPosition: range > 0 ? (c.close - c.low) / range : 0 };
}
export function absorptionScore(volume: number, wick: number, body: number, nearStructure: boolean) {
  return Math.max(0, Math.min(100, Math.min(35, volume / 2.5 * 35) + Math.min(30, wick / 0.6 * 30) + Math.min(15, (1 - body) / 0.85 * 15) + (nearStructure ? 20 : 0)));
}
const valid = (c: Candle) => Number.isFinite(Date.parse(c.time)) && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
  && c.low > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.volume >= 0;

/** Append-only completed-bar engine. All decisions use only data available at that bar. */
export function createAbsorptionEngine(instrument: string, timeframe: string, settings = ABSORPTION_DEFAULTS) {
  const cfg = parseAbsorptionSettings(settings), lookback = Math.max(cfg.volumeLookback, cfg.structureLookback, 15);
  let history: Candle[] = [], last: Candle | null = null;
  const zones: AbsorptionZone[] = [], events: AbsorptionEvent[] = [], diagnostics: AbsorptionDiagnostic[] = [];
  const terminate = (c: Candle, reason: string) => { for (const z of zones) if (z.status === "Candidate") { z.status = "Invalidated"; z.endedAt = c.time; z.reason = reason; } };
  function append(c: Candle) {
    if (c.complete !== true) return;
    const at = Date.parse(c.time);
    if (last && at <= Date.parse(last.time)) {
      if (at === Date.parse(last.time) && ["open", "high", "low", "close", "volume"].some(k => c[k as keyof Candle] !== last![k as keyof Candle])) throw new Error("A completed absorption candle was revised; reload history.");
      return;
    }
    const diag: AbsorptionDiagnostic = { time: c.time, bullish: [], bearish: [] };
    diagnostics.push(diag); if (diagnostics.length > 200) diagnostics.shift();
    if (!valid(c)) { terminate(c, "Missing or invalid candle data"); history = []; last = c; diag.bullish = diag.bearish = ["Missing or invalid OHLCV"]; return; }
    if (last) {
      const end = candleEnd(Date.parse(last.time), timeframe);
      if (at < end || at > end && intervalTraded(end, at, [], instrument)) { terminate(c, "Missing candle gap"); history = []; }
    }
    last = c;
    // State advances before new candidates are registered: same-bar confirmation is impossible.
    for (const z of zones) if (z.status === "Candidate") {
      z.age++;
      if (z.direction === "bullish" ? c.close < z.low : c.close > z.high) { z.status = "Invalidated"; z.endedAt = c.time; z.reason = "Closed beyond the candidate extreme"; }
      else if (z.age <= cfg.confirmationWindow && (z.direction === "bullish" ? c.close > z.high : c.close < z.low)) {
        z.status = "Confirmed"; z.confirmationTime = c.time; z.confirmationPrice = c.close;
        events.push({ id: `${z.id}:confirmed`, zoneId: z.id, instrument, timeframe, direction: z.direction, phase: "confirmed", time: c.time, price: c.close, score: z.score });
      } else if (z.age >= cfg.confirmationWindow) { z.status = "Expired"; z.endedAt = c.time; z.reason = "Confirmation window ended"; }
    }
    if (history.length < lookback) diag.bullish = diag.bearish = ["Insufficient completed history"];
    else {
      const previousVolume = history.slice(-cfg.volumeLookback).reduce((sum, bar) => sum + bar.volume, 0) / cfg.volumeLookback;
      const relativeVolume = previousVolume > 0 ? c.volume / previousVolume : 0;
      const tail = history.slice(-15), atr = tail.slice(1).reduce((sum, bar, i) => sum + Math.max(bar.high - bar.low, Math.abs(bar.high - tail[i].close), Math.abs(bar.low - tail[i].close)), 0) / 14;
      const structure = history.slice(-cfg.structureLookback), support = Math.min(...structure.map(bar => bar.low)), resistance = Math.max(...structure.map(bar => bar.high));
      const g = candleGeometry(c);
      Object.assign(diag, { relativeVolume, atr, bodyRatio: g.bodyRatio, lowerWickRatio: g.lowerWickRatio, upperWickRatio: g.upperWickRatio, support, resistance });
      for (const direction of ["bullish", "bearish"] as const) {
        const bull = direction === "bullish", wick = bull ? g.lowerWickRatio : g.upperWickRatio, other = bull ? g.upperWickRatio : g.lowerWickRatio;
        const near = bull ? Math.abs(c.low - support) <= cfg.structureToleranceAtr * atr : Math.abs(c.high - resistance) <= cfg.structureToleranceAtr * atr;
        const score = absorptionScore(relativeVolume, wick, g.bodyRatio, near), reasons: string[] = [];
        if (!(previousVolume > 0) || c.volume <= 0 || relativeVolume < cfg.relativeVolume) reasons.push("Relative tick activity too low or unavailable");
        if (!(atr > 0) || g.range < cfg.minimumRangeAtr * atr || !g.range) reasons.push("Range below ATR threshold");
        if (wick < cfg.wickRatio || wick <= other) reasons.push("Insufficient directional wick rejection");
        if (bull ? g.closingPosition < 0.55 : g.closingPosition > 0.45) reasons.push("Close lacks rejection");
        if (g.bodyRatio > cfg.bodyRatio) reasons.push("Body too large");
        if (!near) reasons.push("Not near prior structure");
        if (score < cfg.minimumScore) reasons.push("Strength below threshold");
        diag[direction] = reasons;
        if (!reasons.length) {
          const id = `abs-v1:${instrument}:${timeframe}:${c.time}:${direction}`;
          zones.push({ id, instrument, timeframe, direction, time: c.time, high: c.high, low: c.low, top: bull ? Math.min(c.open, c.close) : c.high, bottom: bull ? c.low : Math.max(c.open, c.close),
            score: Math.round(score), relativeVolume, wickRatio: wick, bodyRatio: g.bodyRatio, atr, support, resistance, status: "Candidate", confirmationPrice: null, confirmationTime: null, endedAt: null, reason: null, age: 0 });
          events.push({ id: `${id}:candidate`, zoneId: id, instrument, timeframe, direction, phase: "candidate", time: c.time, price: c.close, score: Math.round(score) });
        }
      }
    }
    history.push(c); if (history.length > lookback) history.shift();
    while (zones.length > 35) zones.shift();
  }
  return { append, snapshot: () => ({ zones: zones.slice(-35).map(z => ({ ...z })), events: [...events], diagnostics: [...diagnostics] }) };
}
export function calculateAbsorption(candles: readonly Candle[], instrument: string, timeframe: string, settings = ABSORPTION_DEFAULTS) {
  const engine = createAbsorptionEngine(instrument, timeframe, settings);
  for (const candle of [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) engine.append(candle);
  return engine.snapshot();
}
