/**
 * h1-next-candle-v1 — frozen deterministic V1 predictor.
 *
 * Scoring is pre-specified before sealed evaluation (not fit to dev WR).
 * Uses only ContextFeatures built from bars with index < target.
 */
import type { ContextFeatures } from "./candles.js";
import type { CandleClass } from "./candles.js";
import type { PredictDirection } from "./metrics.js";

export type Prediction = {
  direction: PredictDirection;
  score: number;
  predictedClass: CandleClass;
  breakdown: Record<string, number>;
};

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

export function predictNext(ctx: ContextFeatures): Prediction {
  const b: Record<string, number> = {};

  // 1) Previous candle type — slight continuation bias for strong bodies
  switch (ctx.prevCls) {
    case "STRONG_BULL": b.type = 0.16; break;
    case "BULL": b.type = 0.08; break;
    case "STRONG_BEAR": b.type = -0.16; break;
    case "BEAR": b.type = -0.08; break;
    default: b.type = 0; break;
  }

  // 2) Two-candle sequence
  if (ctx.seq2 === "UP-UP") b.seq2 = 0.10;
  else if (ctx.seq2 === "DOWN-DOWN") b.seq2 = -0.10;
  else if (ctx.seq2 === "UP-DOWN") b.seq2 = -0.06;
  else if (ctx.seq2 === "DOWN-UP") b.seq2 = 0.06;
  else b.seq2 = 0;

  // 3) Three-candle sequence
  if (ctx.seq3.endsWith("UP-UP-UP")) b.seq3 = 0.08;
  else if (ctx.seq3.endsWith("DOWN-DOWN-DOWN")) b.seq3 = -0.08;
  else b.seq3 = 0;

  // 4) Wick / shape (reversal-leaning for long wicks)
  if (ctx.shapes.longLowerWick) b.wick = 0.12;
  else if (ctx.shapes.longUpperWick) b.wick = -0.12;
  else b.wick = 0;
  if (ctx.shapes.bullishEngulfing) b.engulf = 0.10;
  else if (ctx.shapes.bearishEngulfing) b.engulf = -0.10;
  else b.engulf = 0;
  if (ctx.shapes.insideBar) b.inside = 0.04 * Math.sign(ctx.ret1h || 0);
  else b.inside = 0;
  if (ctx.shapes.outsideBar) b.outside = 0.06 * Math.sign(ctx.ret1h || 0);
  else b.outside = 0;

  // 5) Streak — fade extended runs
  if (ctx.bullStreak >= 4) b.streak = -0.10;
  else if (ctx.bullStreak >= 2) b.streak = 0.06;
  else if (ctx.bearStreak >= 4) b.streak = 0.10;
  else if (ctx.bearStreak >= 2) b.streak = -0.06;
  else b.streak = 0;

  // 6) Volatility regime
  switch (ctx.volRegime) {
    case "EXPANDING": b.vol = 0.06 * Math.sign(ctx.ret1h || 0); break;
    case "CONTRACTING": b.vol = -0.04 * Math.sign(ctx.ret1h || 0); break;
    case "HIGH_VOLATILITY": b.vol = -0.03 * Math.sign(ctx.bullStreak - ctx.bearStreak); break;
    case "LOW_VOLATILITY": b.vol = 0.02 * Math.sign(ctx.ret3h || 0); break;
    default: b.vol = 0; break;
  }

  // 7) Price location
  if (ctx.range20Loc <= 0.25) b.loc = 0.10;
  else if (ctx.range20Loc >= 0.75) b.loc = -0.10;
  else if (ctx.distEma20Atr > 1.5) b.loc = -0.06;
  else if (ctx.distEma20Atr < -1.5) b.loc = 0.06;
  else b.loc = 0;

  // 8) Recent return drift
  b.ret = clamp((ctx.ret3h * 0.04 + ctx.ret5h * 0.03), -0.08, 0.08);

  const raw = Object.values(b).reduce((s, x) => s + x, 0);
  const score = clamp(raw);

  let direction: PredictDirection = "WAIT";
  if (score >= 0.60) direction = "BUY";
  else if (score <= -0.60) direction = "SELL";

  let predictedClass: CandleClass = "DOJI";
  if (score >= 0.75) predictedClass = "STRONG_BULL";
  else if (score >= 0.35) predictedClass = "BULL";
  else if (score <= -0.75) predictedClass = "STRONG_BEAR";
  else if (score <= -0.35) predictedClass = "BEAR";
  else predictedClass = "DOJI";

  return { direction, score, predictedClass, breakdown: b };
}

export function directionFromScore(score: number, threshold = 0.60): PredictDirection {
  if (score >= threshold) return "BUY";
  if (score <= -threshold) return "SELL";
  return "WAIT";
}
