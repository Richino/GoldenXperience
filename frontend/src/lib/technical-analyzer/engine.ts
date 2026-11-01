import type { Candle } from "../../types/forex";
import { calculateAtrValues, calculateEmaValues } from "../strategy/indicators";
import { brokerOpen, candleAligned, candleEnd, intervalTraded } from "../strategy/candle-clock";
import { sessionHour, NEW_YORK_TIME_ZONE } from "../strategy/session";
import type { Frame, FrameAnalysis, Forecast, Horizon, Pivot, Snapshot, StructureEvent, Zone, MetricObservation, Metric, Outcome } from "./types";
import { calculateReadings } from "./ratings";
import { scheduledTrading } from "./quality";
import { assessLevelRisk } from "./levels";
import { buildOutlook, EVIDENCE_RULES } from "./outlook";

export const MODEL_VERSION = "gx-technical-1.4.0";
export const RULES = Object.freeze({ trendThreshold: 0.45, momentumThreshold: 0.12, minAdx: 18, pivotBars: 3, breakAtr: 0.1 });
export const FRAMES: Frame[] = ["H1", "H4", "D", "W"];
const weights: Record<Horizon, Partial<Record<Frame, number>>> = {
  1: { H1: 0.6, H4: 0.4 }, 2: { H1: 0.2, H4: 0.8 }, 3: { H4: 0.5, D: 0.5 }, 4: { H4: 0.2, D: 0.8 }, 5: { D: 0.65, W: 0.35 },
};
const last = (a: Array<number | null>) => a.at(-1) ?? 0;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sign = (v: number): -1 | 0 | 1 => v > 0 ? 1 : v < 0 ? -1 : 0;
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, weekday: "short" });

function missingCandleOpens(open: number, until: number, frame: Frame, withHolidays = false): number[] {
  const result: number[] = [];
  for (let next = candleEnd(open, frame), steps = 0; next < until && steps < 600; next = candleEnd(next, frame), steps++) {
    // W candles are Friday-aligned and contain the following trading week.
    if (withHolidays ? intervalTraded(next, candleEnd(next, frame)) : scheduledTrading(next, candleEnd(next, frame))) result.push(next);
  }
  return result;
}

/** Nth future Mon–Fri NY17 boundary; the first may be a partial trading day. */
export function expiration(at: number, horizon: Horizon): string {
  if (!Number.isFinite(at)) throw new Error("Invalid forecast timestamp.");
  let remaining = horizon;
  const day = Math.floor(at / 86400000) * 86400000;
  for (let d = 0; d < 14; d++) {
    const boundary = sessionHour(day + d * 86400000, 17, NEW_YORK_TIME_ZONE);
    if (boundary <= at || ["Sat", "Sun"].includes(weekday.format(boundary))) continue;
    if (--remaining === 0) return new Date(boundary).toISOString();
  }
  throw new Error("Could not resolve trading-day expiration.");
}

export function rsiSeries(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = closes.map(() => null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gain = i <= period ? gain + Math.max(delta, 0) : (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = i <= period ? loss + Math.max(-delta, 0) : (loss * (period - 1) + Math.max(-delta, 0)) / period;
    if (i === period) { gain /= period; loss /= period; }
    if (i >= period) out[i] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder's directional movement, seeded with periods 1..14 and ADX at 27. */
export function directional(c: Candle[], period = 14) {
  let tr = 0, plus = 0, minus = 0, adx = 0, plusDI = 0, minusDI = 0;
  const dx: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, down = c[i - 1].low - c[i].low;
    const t = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    const p = up > down && up > 0 ? up : 0, m = down > up && down > 0 ? down : 0;
    tr = i <= period ? tr + t : tr - tr / period + t;
    plus = i <= period ? plus + p : plus - plus / period + p;
    minus = i <= period ? minus + m : minus - minus / period + m;
    if (i < period) continue;
    plusDI = tr ? 100 * plus / tr : 0; minusDI = tr ? 100 * minus / tr : 0;
    const value = plusDI + minusDI ? 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI) : 0;
    dx.push(value);
    if (dx.length === period) adx = mean(dx);
    else if (dx.length > period) adx = (adx * (period - 1) + value) / period;
  }
  return { adx, plusDI, minusDI };
}

export function confirmedStructure(c: Candle[], atr: number, frame: Frame) {
  if (!(atr > 0)) throw new Error("Structure requires positive ATR.");
  const priorAtrs = calculateAtrValues(c, 14);
  const pivots: Pivot[] = [], events: StructureEvent[] = [];
  let lastHigh: Pivot | undefined, lastLow: Pivot | undefined, direction = 0;
  const broken = new Set<string>();
  for (let i = 0; i < c.length; i++) {
    const p = i - RULES.pivotBars;
    if (p >= RULES.pivotBars) {
      const around = c.slice(p - RULES.pivotBars, p + RULES.pivotBars + 1);
      for (const kind of ["high", "low"] as const) {
        if (!around.every((b, j) => j === RULES.pivotBars || (kind === "high" ? c[p].high > b.high : c[p].low < b.low))) continue;
        const pivot: Pivot = { kind, price: c[p][kind], index: p, time: c[p].time, confirmedAt: new Date(candleEnd(Date.parse(c[i].time), frame)).toISOString() };
        pivots.push(pivot);
        if (kind === "high") lastHigh = pivot; else lastLow = pivot;
      }
    }
    // The buffer uses prior data only, never the final frame ATR during replay.
    const buffer = (priorAtrs[i - 1] ?? 0) * RULES.breakAtr;
    for (const [pivot, side] of [[lastHigh, 1], [lastLow, -1]] as const) {
      if (!pivot || broken.has(pivot.time + pivot.kind)) continue;
      if (side * (c[i].close - pivot.price) <= buffer) continue;
      const key = pivot.time + pivot.kind;
      broken.add(key);
      events.push({ kind: direction && direction !== side ? "CHoCH" : "BOS", direction: side === 1 ? "up" : "down", level: pivot.price, at: new Date(candleEnd(Date.parse(c[i].time), frame)).toISOString() });
      direction = side;
    }
  }
  const highs = pivots.filter(p => p.kind === "high").slice(-2), lows = pivots.filter(p => p.kind === "low").slice(-2);
  const structure: FrameAnalysis["structure"] = highs.length < 2 || lows.length < 2 ? "mixed / range"
    : highs[1].price > highs[0].price && lows[1].price > lows[0].price ? "higher highs / higher lows"
    : highs[1].price < highs[0].price && lows[1].price < lows[0].price ? "lower highs / lower lows" : "mixed / range";
  const recent = events.slice(-8);
  for (const e of recent.filter(e => e.kind !== "FAILED BREAKOUT")) {
    const index = c.findIndex(b => candleEnd(Date.parse(b.time), frame) === Date.parse(e.at));
    const failureBuffer = (priorAtrs[index - 1] ?? 0) * RULES.breakAtr;
    const failure = c.slice(index + 1, index + 4).find(b => (e.direction === "up" ? b.close < e.level - failureBuffer : b.close > e.level + failureBuffer));
    if (failure) recent.push({ ...e, kind: "FAILED BREAKOUT", at: new Date(candleEnd(Date.parse(failure.time), frame)).toISOString() });
  }
  return { pivots, structure, events: recent.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-8) };
}

export function reactionZones(c: Candle[], pivots: Pivot[], frame: Frame, atr: number, reference: number, pip: number): Zone[] {
  const clusters: Array<{ low: number; high: number; pivots: Pivot[] }> = [];
  for (const p of pivots.slice(-100).sort((a, b) => a.price - b.price)) {
    const previous = clusters.at(-1);
    if (previous && p.price - previous.low <= atr * 0.3) { previous.high = p.price; previous.pivots.push(p); }
    else clusters.push({ low: p.price, high: p.price, pivots: [p] });
  }
  return clusters.map(z => {
    const low = z.low - atr * 0.05, high = z.high + atr * 0.05;
    const established = Math.min(...z.pivots.map(p => Date.parse(p.confirmedAt)));
    let role: Zone["role"] = z.pivots[0].kind === "low" ? "support" : "resistance";
    let brokenAt: string | null = null, retestedAt: string | null = null;
    for (const b of c.filter(b => Date.parse(b.time) >= established)) {
      if ((role === "support" && b.close < low - atr * 0.1) || (role === "resistance" && b.close > high + atr * 0.1)) {
        role = role === "support" ? "resistance" : "support";
        brokenAt = new Date(candleEnd(Date.parse(b.time), frame)).toISOString(); retestedAt = null;
      } else if (brokenAt && Date.parse(b.time) >= Date.parse(brokenAt) && b.low <= high && b.high >= low && (role === "support" ? b.close > high : b.close < low)) {
        retestedAt = new Date(candleEnd(Date.parse(b.time), frame)).toISOString();
      }
    }
    const distance = Math.max(low - reference, reference - high, 0);
    return { frame, low, high, role, reactions: z.pivots.length, quality: mean(z.pivots.map(p => {
      const b = c[p.index]; return Math.abs(b.close - p.price) / atr;
    })), distancePips: distance / pip, distanceAtr: distance / atr, brokenAt, retestedAt };
  }).sort((a, b) => a.distanceAtr - b.distanceAtr).slice(0, 12);
}

export function analyzeFrame(c: Candle[], frame: Frame, reference: number, pip: number): FrameAnalysis {
  if (c.length < 260) throw new Error(`${frame}: at least 260 completed candles required.`);
  const closes = c.map(b => b.close), atrs = calculateAtrValues(c, 14), atr = last(atrs);
  if (atr <= 0) throw new Error(`${frame}: zero volatility; analysis unavailable.`);
  const e20 = calculateEmaValues(closes, 20), e50 = calculateEmaValues(closes, 50), e200 = calculateEmaValues(closes, 200);
  const fast = calculateEmaValues(closes, 12), slow = calculateEmaValues(closes, 26);
  const macds = fast.flatMap((v, i) => v !== null && slow[i] !== null ? [v - slow[i]!] : []);
  const signals = calculateEmaValues(macds, 9), histogram = macds.at(-1)! - last(signals);
  const rsis = rsiSeries(closes), structure = confirmedStructure(c, atr, frame);
  const low = structure.pivots.filter(p => p.kind === "low").slice(-2), high = structure.pivots.filter(p => p.kind === "high").slice(-2);
  const recent = (p: Pivot[]) => p.length === 2 && p[0].index >= 14 && p[1].index - p[0].index <= 60 && c.length - p[1].index <= 20;
  const divergence = recent(low) && low[1].price < low[0].price && rsis[low[1].index]! > rsis[low[0].index]! + 5 ? "bullish"
    : recent(high) && high[1].price > high[0].price && rsis[high[1].index]! < rsis[high[0].index]! - 5 ? "bearish" : null;
  const close = closes.at(-1)!;
  const slope20Atr = (last(e20) - e20.at(-6)!) / atr;
  const trend = close > last(e20) && last(e20) > last(e50) && last(e50) > last(e200) && slope20Atr > 0 ? 1
    : close < last(e20) && last(e20) < last(e50) && last(e50) < last(e200) && slope20Atr < 0 ? -1 : 0;
  const strength = directional(c);
  const readings = calculateReadings(c, { rsi: last(rsis), macd: macds.at(-1)!, signal: last(signals), atr, ...strength }, rsis.at(-2)!);
  return { frame, count: c.length, lastOpen: c.at(-1)!.time, lastCloseAt: new Date(candleEnd(Date.parse(c.at(-1)!.time), frame)).toISOString(), close, readings,
    ema20: last(e20), ema50: last(e50), ema200: last(e200), slope20Atr,
    slope50Atr: (last(e50) - e50.at(-6)!) / atr, slope200Atr: (last(e200) - e200.at(-6)!) / atr,
    rsi: last(rsis), macd: macds.at(-1)!, signal: last(signals), histogram,
    acceleration: histogram - (macds.at(-2)! - signals.at(-2)!), ...strength, atr,
    volatilityRatio: atr / mean(atrs.slice(-100).filter((v): v is number => v !== null)), trend,
    consolidation: Math.max(...c.slice(-12).map(b => b.high)) - Math.min(...c.slice(-12).map(b => b.low)) < atr * 2.5,
    divergence, ...structure, zones: reactionZones(c, structure.pivots, frame, atr, reference, pip) };
}

export function buildForecast(snapshot: Pick<Snapshot, "frames" | "referencePrice" | "pip" | "createdAt" | "eligible" | "technicalAvailable">, horizon: Horizon): Forecast {
  const fmt = (v: number) => v.toFixed(Math.max(0, Math.round(-Math.log10(snapshot.pip)) + 1));
  const w = weights[horizon], selected = FRAMES.filter(f => w[f]);
  const aggregate = (fn: (f: FrameAnalysis) => number) => selected.reduce((s, key) => s + w[key]! * fn(snapshot.frames[key]), 0);
  // Correlated indicators stay within their group; strength only gates direction.
  const frameTrend = (f:FrameAnalysis) => 0.65 * f.trend + 0.35 * (f.structure === "higher highs / higher lows" ? 1 : f.structure === "lower highs / lower lows" ? -1 : 0);
  const trend = aggregate(frameTrend);
  const momentum = aggregate(f => 0.5 * sign(f.histogram) + 0.5 * Math.max(-1, Math.min(1, (f.rsi - 50) / 20)));
  const strength = aggregate(f => f.adx), dominant = snapshot.frames[selected.reduce((a, b) => w[a]! >= w[b]! ? a : b)];
  const direction = sign(trend);
  const zones = FRAMES.flatMap(f => snapshot.frames[f].zones).filter(z => selected.includes(z.frame) || z.frame === "D" || z.frame === "W").sort((a, b) => a.distanceAtr - b.distanceAtr);
  // Location distance is normalized by the primary horizon ATR, including major zones.
  const levelRisk = assessLevelRisk(zones, snapshot.referencePrice, dominant.atr, direction);
  const opposing = levelRisk.zone;
  const exhausted = aggregate(f => f.rsi > 75 || f.rsi < 25 || Math.abs(f.close - f.ema20) > 2 * f.atr ? 1 : 0) >= 0.5;
  const contradictions: string[] = [];
  if (trend * momentum <= 0) contradictions.push("Trend and momentum groups disagree or lack direction.");
  for (const key of selected) {
    const f = snapshot.frames[key];
    if (f.trend !== direction) contradictions.push(`${key} EMA alignment does not support the dominant direction.`);
    if (f.divergence) contradictions.push(`${key} confirmed ${f.divergence} RSI divergence; reversal risk, not a reversal confirmation.`);
    if (f.events.at(-1)?.kind === "FAILED BREAKOUT") contradictions.push(`${key} recently failed a confirmed breakout.`);
  }
  if (opposing) contradictions.push(`${opposing.frame} ${opposing.role} ${fmt(opposing.low)}–${fmt(opposing.high)} may obstruct continuation (${levelRisk.severity === "HIGH" ? "major level" : "nearby level"}); break/retest confirmation reduces this risk.`);
  if (exhausted) contradictions.push("Overextended momentum/price increases pullback risk.");
  const available = snapshot.technicalAvailable !== false;
  const qualifies = Math.abs(trend) >= RULES.trendThreshold && direction * momentum >= RULES.momentumThreshold && strength >= RULES.minAdx;
  const bias = !available ? "UNAVAILABLE" : qualifies && !exhausted ? direction > 0 ? "BULLISH" : "BEARISH" : "NO EDGE";
  const materialOppositionWeight = selected.reduce((total,key) => total + (frameTrend(snapshot.frames[key])*direction <= -EVIDENCE_RULES.opposingFrameTrend ? w[key]! : 0),0);
  const outlook = buildOutlook({trend,momentum,strength,available,exhausted,levelRisk,materialOppositionWeight,
    reversalRisk:selected.some(key => snapshot.frames[key].divergence !== null || snapshot.frames[key].events.at(-1)?.kind === "FAILED BREAKOUT")});
  const support = zones.filter(z => z.role === "support" && z.low <= snapshot.referencePrice).sort((a, b) => b.high - a.high)[0];
  const resistance = zones.filter(z => z.role === "resistance" && z.high >= snapshot.referencePrice).sort((a, b) => a.low - b.low)[0];
  const floor = support?.low ?? dominant.close - dominant.atr, ceiling = resistance?.high ?? dominant.close + dominant.atr;
  const distance = snapshot.frames.D.atr * Math.sqrt(horizon);
  return { horizon, expiresAt: expiration(Date.parse(snapshot.createdAt), horizon), bias, evidence: !available ? "LIMITED" : bias === "NO EDGE" || outlook.lean.evidence === "MIXED" ? "MIXED" : "ALIGNED", levelRisk, ...outlook,
    trendStrength: strength >= 25 ? "established trend" : strength >= 18 ? "developing trend" : "weak / range",
    momentum: momentum > 0.12 ? "bullish momentum" : momentum < -0.12 ? "bearish momentum" : "mixed momentum",
    structure: `${dominant.frame}: ${dominant.structure}`, regime: dominant.consolidation ? "consolidation" : dominant.volatilityRatio > 1.3 ? "high volatility" : dominant.volatilityRatio < 0.7 ? "low volatility" : "normal volatility",
    groups: { trend, momentum, strength, location: opposing ? levelRisk.severity === "HIGH" ? "major opposing zone" : "nearby opposing zone" : "no nearby opposing zone detected", exhaustion: exhausted ? "extended" : "not extended" }, frames: selected,
    reasons: [`Emphasis: ${selected.map(f => `${f} ${w[f]! * 100}%`).join(", ")}.`, `Trend group ${trend.toFixed(2)}; momentum group ${momentum.toFixed(2)}; ADX ${strength.toFixed(1)}.`,
      !available ? "Required completed-candle data is not reliable enough for a technical outlook." : bias === "NO EDGE" ? `Directional evidence unresolved: ${[
        Math.abs(trend) < RULES.trendThreshold ? "trend/structure alignment below threshold" : "",
        direction * momentum < RULES.momentumThreshold ? "momentum insufficient or opposing the trend" : "",
        strength < RULES.minAdx ? "trend strength below threshold" : "", exhausted ? "exhaustion conflicts with continuation" : "",
      ].filter(Boolean).join("; ")}.` : `Trend, momentum and strength support a ${direction > 0 ? "bullish" : "bearish"} bias; exhaustion gate passes.`,
      levelRisk.explanation],
    contradictions, zones: zones.slice(0, 10),
    continuation: direction >= 0 ? `${dominant.frame} close above ${fmt(ceiling)} + ${fmt(dominant.atr * RULES.breakAtr)} buffer supports bullish continuation; hold ${fmt(floor)} on a retest.`
      : `${dominant.frame} close below ${fmt(floor)} − ${fmt(dominant.atr * RULES.breakAtr)} buffer supports bearish continuation; reject ${fmt(ceiling)} on a retest.`,
    reversal: direction >= 0 ? `${dominant.frame} close below ${fmt(floor)} followed by a failed reclaim favors a bearish reversal.` : `${dominant.frame} close above ${fmt(ceiling)} followed by a successful retest favors a bullish reversal.`,
    invalidation: `${dominant.frame} close ${direction >= 0 ? "below " + fmt(floor) : "above " + fmt(ceiling)} invalidates the dominant technical scenario. ${!support || !resistance ? "Missing zone uses an explicitly labeled one-ATR fallback level." : ""}`,
    movement: { low: Math.max(0, snapshot.referencePrice - distance), high: snapshot.referencePrice + distance, pips: distance / snapshot.pip,
      method: "D1 Wilder ATR(14) × sqrt(horizon), symmetric heuristic envelope; not a calibrated interval or price target." } };
}

export function dataWarnings(c: Candle[], frame: Frame, now: number): string[] {
  if (!c.length) return [`${frame}: no completed candles.`];
  const warnings: string[] = [];
  for (let i = 0; i < c.length; i++) {
    const b = c[i], at = Date.parse(b.time);
    if (!b.complete || !candleAligned(at, frame) || candleEnd(at, frame) > now || ![b.open, b.high, b.low, b.close].every(v => Number.isFinite(v) && v > 0)
      || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || (i > 0 && at <= Date.parse(c[i - 1].time))) throw new Error(`${frame}: malformed, unordered or unconfirmed data.`);
    if (i > 0) {
      const prior = Date.parse(c[i - 1].time);
      if (missingCandleOpens(prior, at, frame).length) warnings.push(`${i < c.length - 20 ? "Historical gap" : "Recent gap"} ${frame}: unexpected missing scheduled candles before ${b.time}; no interpolation applied.`);
      else if (missingCandleOpens(prior, at, frame, true).length) warnings.push(`Expected holiday closure ${frame} before ${b.time}; published OANDA schedule, no interpolation needed.`);
    }
  }
  const end = candleEnd(Date.parse(c.at(-1)!.time), frame);
  const currentCompletedMissing = missingCandleOpens(Date.parse(c.at(-1)!.time), now, frame).some(open => candleEnd(open, frame) <= now);
  if (currentCompletedMissing && end < now && brokerOpen(now)) warnings.push(`${frame}: latest completed candle is stale.`);
  return [...new Set(warnings)].slice(0, 6);
}

export function score(reference: number, forecast: Forecast, price: number, at: string): Outcome {
  const direction = price > reference ? "UP" : price < reference ? "DOWN" : "FLAT";
  return { price, at, direction, correct: forecast.bias === "NO EDGE" || forecast.bias === "UNAVAILABLE" ? null : (forecast.bias === "BULLISH" ? direction === "UP" : direction === "DOWN"),
    leanCorrect: forecast.lean?.direction === "BULLISH" ? direction === "UP" : forecast.lean?.direction === "BEARISH" ? direction === "DOWN" : null, baselineCorrect: false };
}

export function metrics(rows: MetricObservation[]): Metric[] {
  const labels = [...new Set([...rows.map(r => `${r.forecast.horizon}D`), ...rows.map(r => `Pair: ${r.snapshot.instrument}`), ...rows.map(r => `Regime: ${r.forecast.regime}`)])];
  return labels.map(label => {
    const completed = rows.filter(r => r.outcome && r.snapshot.eligible && (label === `${r.forecast.horizon}D` || label === `Pair: ${r.snapshot.instrument}` || label === `Regime: ${r.forecast.regime}`));
    const calls = completed.filter(r => r.forecast.bias === "BULLISH" || r.forecast.bias === "BEARISH");
    const leans = completed.filter(r => (r.forecast.lean?.direction === "BULLISH" || r.forecast.lean?.direction === "BEARISH") && typeof r.outcome!.leanCorrect === "boolean");
    const accuracy = (r: MetricObservation[]) => r.length ? r.filter(r => r.outcome!.correct).length / r.length : null;
    // Greedy non-overlap within pair+horizon, using issue time rather than quote time.
    const ends = new Map<string, number>();
    const independent = calls.slice().sort((a, b) => Date.parse(a.snapshot.createdAt) - Date.parse(b.snapshot.createdAt)).filter(r => {
      const key = `${r.snapshot.instrument}:${r.forecast.horizon}`;
      if (Date.parse(r.snapshot.createdAt) < (ends.get(key) ?? 0)) return false;
      ends.set(key, Date.parse(r.forecast.expiresAt)); return true;
    });
    return { label, completed: completed.length, directional: calls.length, correct: calls.filter(r => r.outcome!.correct).length, accuracy: accuracy(calls),
      baselineAccuracy: calls.length ? calls.filter(r => r.outcome!.baselineCorrect).length / calls.length : null,
      bullishAccuracy: accuracy(calls.filter(r => r.forecast.bias === "BULLISH")), bearishAccuracy: accuracy(calls.filter(r => r.forecast.bias === "BEARISH")),
      independent: independent.length, independentAccuracy: accuracy(independent), leanCalls:leans.length,
      leanAccuracy:leans.length ? leans.filter(r=>r.outcome!.leanCorrect).length/leans.length : null };
  });
}
