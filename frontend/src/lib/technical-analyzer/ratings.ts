import type { Candle } from "../../types/forex";
import { calculateEmaValues } from "../strategy/indicators";
import type { FrameAnalysis, IndicatorAction, IndicatorReading, TechnicalRating, TechnicalReadings } from "./types";

const mean = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;
const action = (value: number, tolerance = 1e-12): IndicatorAction => value > tolerance ? "Buy" : value < -tolerance ? "Sell" : "Neutral";

/** GX display rules, not TradingView parity and not the forecast decision. */
export function calculateReadings(c: Candle[], f: Pick<FrameAnalysis, "rsi" | "adx" | "plusDI" | "minusDI" | "macd" | "signal" | "atr">, priorRsi: number): TechnicalReadings {
  const closes = c.map(b => b.close), close = closes.at(-1)!;
  const averages: IndicatorReading[] = [10,20,30,50,100,200].flatMap(period => {
    const ema = calculateEmaValues(closes, period).at(-1)!, sma = mean(closes.slice(-period));
    return [{ name: `EMA (${period})`, value: ema, action: action(close - ema, f.atr * .01), rule: "Buy above average by >0.01 ATR; Sell below by >0.01 ATR; otherwise Neutral." },
      { name: `SMA (${period})`, value: sma, action: action(close - sma, f.atr * .01), rule: "Buy above average by >0.01 ATR; Sell below by >0.01 ATR; otherwise Neutral." }];
  });
  const rawK = c.map((b, i) => {
    if (i < 13) return 50;
    const window = c.slice(i - 13, i + 1), hi = Math.max(...window.map(x => x.high)), lo = Math.min(...window.map(x => x.low));
    return hi === lo ? 50 : 100 * (b.close - lo) / (hi - lo);
  });
  const k = mean(rawK.slice(-3)), previousK = mean(rawK.slice(-4, -1));
  const d = mean([k, previousK, mean(rawK.slice(-5, -2))]);
  const previousD = mean([previousK, mean(rawK.slice(-5, -2)), mean(rawK.slice(-6, -3))]);
  const cci = (offset: number) => {
    const window = offset ? c.slice(-20 - offset, -offset) : c.slice(-20);
    const typical = window.map(b => (b.high + b.low + b.close) / 3), average = mean(typical), deviation = mean(typical.map(v => Math.abs(v - average)));
    return deviation ? (typical.at(-1)! - average) / (.015 * deviation) : 0;
  };
  const cciNow = cci(0), cciPrior = cci(1);
  const williams = (offset: number) => {
    const window = offset ? c.slice(-14 - offset, -offset) : c.slice(-14);
    const hi = Math.max(...window.map(b => b.high)), lo = Math.min(...window.map(b => b.low));
    return hi === lo ? -50 : -100 * (hi - window.at(-1)!.close) / (hi - lo);
  };
  const wr = williams(0), priorWr = williams(1);
  const mid = c.map(b => (b.high + b.low) / 2);
  const ao = mean(mid.slice(-5)) - mean(mid.slice(-34)), priorAo = mean(mid.slice(-6, -1)) - mean(mid.slice(-35, -1));
  const momentum = close - closes.at(-11)!;
  const oscillators: IndicatorReading[] = [
    { name: "RSI (14)", value: f.rsi, action: f.rsi < 30 && f.rsi > priorRsi ? "Buy" : f.rsi > 70 && f.rsi < priorRsi ? "Sell" : "Neutral", rule: "Buy below 30 and rising; Sell above 70 and falling; otherwise Neutral." },
    { name: "Stochastic (14, 3, 3)", value: k, extra: `%D ${d.toFixed(2)}`, action: k < 20 && k > d && previousK <= previousD ? "Buy" : k > 80 && k < d && previousK >= previousD ? "Sell" : "Neutral", rule: "Buy a bullish K/D cross below 20; Sell a bearish cross above 80; otherwise Neutral." },
    { name: "CCI (20)", value: cciNow, action: cciNow < -100 && cciNow > cciPrior ? "Buy" : cciNow > 100 && cciNow < cciPrior ? "Sell" : "Neutral", rule: "Buy below -100 and rising; Sell above 100 and falling; otherwise Neutral." },
    { name: "ADX (14) / DI", value: f.adx, extra: `+DI ${f.plusDI.toFixed(2)} / −DI ${f.minusDI.toFixed(2)}`, action: f.adx > 20 ? action(f.plusDI - f.minusDI) : "Neutral", rule: "ADX >20: Buy when +DI > -DI, Sell for the reverse; otherwise Neutral." },
    { name: "Momentum (10)", value: momentum, action: action(momentum, f.atr * .01), rule: "Buy positive close-to-close change over 10 bars; Sell negative; Neutral within 0.01 ATR." },
    { name: "MACD (12, 26, 9)", value: f.macd, extra: `Signal ${f.signal.toFixed(6)}`, action: action(f.macd - f.signal, f.atr * 1e-8), rule: "Buy MACD above signal; Sell below signal; equality Neutral." },
    { name: "Williams %R (14)", value: wr, action: wr < -80 && wr > priorWr ? "Buy" : wr > -20 && wr < priorWr ? "Sell" : "Neutral", rule: "Buy below -80 and rising; Sell above -20 and falling; otherwise Neutral." },
    { name: "Awesome Oscillator (5, 34)", value: ao, action: ao > 0 && ao > priorAo ? "Buy" : ao < 0 && ao < priorAo ? "Sell" : "Neutral", rule: "Buy positive and rising; Sell negative and falling; otherwise Neutral." },
  ];
  if ([...oscillators, ...averages].some(r => !Number.isFinite(r.value))) throw new Error("Indicator readings contain invalid values.");
  return { oscillators, averages };
}

export function rating(rows: IndicatorReading[], scoreOverride?: number): TechnicalRating {
  const sell = rows.filter(r => r.action === "Sell").length, buy = rows.filter(r => r.action === "Buy").length, neutral = rows.length - sell - buy;
  const score = scoreOverride ?? (rows.length ? (buy - sell) / rows.length : 0);
  return { score, sell, neutral, buy, label: score <= -.5 ? "Strong Sell" : score < -.1 ? "Sell" : score >= .5 ? "Strong Buy" : score > .1 ? "Buy" : "Neutral" };
}

export function technicalSummary(readings: TechnicalReadings) {
  const oscillators = rating(readings.oscillators), averages = rating(readings.averages);
  return { oscillators, averages, overall: rating([...readings.oscillators, ...readings.averages], (oscillators.score + averages.score) / 2) };
}

/** Old immutable reports did not record the additional oscillator calculations. */
export function recordedReadings(f: FrameAnalysis): TechnicalReadings {
  return f.readings ?? { oscillators: [
    { name: "ADX (14) / DI", value: f.adx, action: f.adx > 20 ? action(f.plusDI - f.minusDI) : "Neutral", rule: "ADX >20 and dominant DI direction." },
    { name: "MACD (12, 26, 9)", value: f.macd, action: action(f.macd - f.signal), rule: "MACD versus signal." },
  ], averages: ([20,50,200] as const).map(p => ({ name: `EMA (${p})`, value: f[`ema${p}`], action: action(f.close - f[`ema${p}`], f.atr * .01), rule: "Close versus EMA with 0.01 ATR neutral band." })) };
}
