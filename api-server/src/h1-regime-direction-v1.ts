/**
 * Research-only H1 regime classifier.
 *
 * This deliberately answers only UP, DOWN, or NO_DIRECTION from completed H1
 * candles. It neither chooses an entry nor creates a stop, target, or order.
 */
export type H1Direction = "UP" | "DOWN" | "NO_DIRECTION";

export type H1DirectionCandle = {
  close: number;
  high: number;
  low: number;
};

const SLOPE_BARS = 48;
const STRUCTURE_BARS = 24;

function ema(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  const valuesOut = [values[0]!];
  for (let index = 1; index < values.length; index++) valuesOut.push(values[index]! * multiplier + valuesOut[index - 1]! * (1 - multiplier));
  return valuesOut;
}

function atr(bars: H1DirectionCandle[], period: number) {
  const values = new Array<number>(bars.length).fill(Number.NaN); let smoothed = 0;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!; const previous = bars[index - 1];
    const trueRange = previous ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)) : bar.high - bar.low;
    if (index < period) { smoothed += trueRange; if (index === period - 1) values[index] = smoothed / period; }
    else { smoothed = ((values[index - 1] as number) * (period - 1) + trueRange) / period; values[index] = smoothed; }
  }
  return values;
}

function regressionSlope(values: number[]) {
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0; let denominator = 0;
  for (let index = 0; index < values.length; index++) { numerator += (index - meanX) * (values[index]! - meanY); denominator += (index - meanX) ** 2; }
  return denominator ? numerator / denominator : 0;
}

/** The former H1 component, isolated so its directional information can be audited. */
export function classifyH1RegimeDirectionV1(bars: H1DirectionCandle[]): H1Direction {
  if (bars.length < SLOPE_BARS + 2) return "NO_DIRECTION";
  const currentAtr = atr(bars, 14).at(-1)!;
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return "NO_DIRECTION";
  const closes = bars.map((bar) => bar.close);
  const ema21 = ema(closes, 21).at(-1)!; const ema50 = ema(closes, 50).at(-1)!;
  const normalizedSlope = regressionSlope(closes.slice(-SLOPE_BARS)) / currentAtr;
  const structure = bars.slice(-STRUCTURE_BARS); const earlier = structure.slice(0, STRUCTURE_BARS / 2); const recent = structure.slice(STRUCTURE_BARS / 2);
  const higherHigh = Math.max(...recent.map((bar) => bar.high)) > Math.max(...earlier.map((bar) => bar.high));
  const higherLow = Math.min(...recent.map((bar) => bar.low)) > Math.min(...earlier.map((bar) => bar.low));
  const lowerLow = Math.min(...recent.map((bar) => bar.low)) < Math.min(...earlier.map((bar) => bar.low));
  const lowerHigh = Math.max(...recent.map((bar) => bar.high)) < Math.max(...earlier.map((bar) => bar.high));
  const current = bars.at(-1)!;
  if (normalizedSlope >= 0.05 && higherHigh && higherLow && ema21 > ema50 && current.close > ema21) return "UP";
  if (normalizedSlope <= -0.05 && lowerLow && lowerHigh && ema21 < ema50 && current.close < ema21) return "DOWN";
  return "NO_DIRECTION";
}
