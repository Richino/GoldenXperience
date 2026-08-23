import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Pattern V1 — the FROZEN rule, ported verbatim from the research that produced
 * it. Pure: no clock, no database, no network.
 *
 * Every function below is a line-for-line port of
 * `api-server/scripts/_binary-adaptive-bollinger-rsi-10k-audit.ts`, which
 * `PATTERN_V1_HOLDOUT_FREEZE.json` names as the authoritative implementation
 * (`patternDefinition: ... matchesPattern()`). Nothing is re-derived, re-tuned
 * or "cleaned up": given identical candles this must return exactly what the
 * research evaluator returned, and a regression fixture asserts it does.
 *
 * THE RULE
 *
 *     UP
 *     AND BB re-entry (with RSI at the threshold, which is what makes a signal)
 *     AND (
 *           (rsiSeverity == extreme AND adxBucket == gt30)     -- V1a
 *        OR (rsiSeverity == medium  AND adxBucket == b20_25)   -- V1b
 *     )
 *
 * The parenthesisation is load-bearing. Both branches sit INSIDE the UP and
 * re-entry requirement; neither is an independent way to fire.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE PROSE SPEC. The written brief describes
 * V1b's ADX band as "ADX >= 20 AND ADX <= 25". The frozen bucket is
 * `20 < adx <= 25`, and the freeze file calls this out explicitly:
 * "ADX==20 is le20, NOT medium branch." At exactly 20.0 the two readings
 * disagree. The frozen definition wins, because this is a forward test OF the
 * frozen rule — changing the boundary would test something else.
 */

// ---------------------------------------------------------------- identity

export const PATTERN_V1_STRATEGY_ID = "binary-pattern-v1";
export const PATTERN_V1_STRATEGY_VERSION = "1.0.0";
export const PATTERN_V1_SOURCE = "pattern-v1-forward";
export const PATTERN_V1_EXPERIMENT_ID = "pattern-v1-sealed-holdout-v1";

/**
 * SHA-256 of PATTERN_V1_HOLDOUT_FREEZE.json, LF-normalized.
 *
 * The normalization is not incidental: the research verifier hashes the file
 * after replacing CRLF with LF, and a Windows checkout stores CRLF, so hashing
 * the raw bytes yields a different digest.
 */
export const PATTERN_V1_CONFIG_HASH =
  "0e3cba650a3b62fda62db80d4b4af4bc37536851f233cadd4d995aca990f05cd";

const FREEZE_PATH = path.join(
  process.cwd().endsWith("api-server") ? process.cwd() : path.join(process.cwd(), "api-server"),
  "research-v2", "pattern-v1-holdout", "PATTERN_V1_HOLDOUT_FREEZE.json",
);

/**
 * Recompute the freeze hash from the file on disk.
 *
 * This is what makes "the running configuration is identical to the historical
 * holdout configuration" a checkable claim rather than a comment. Returns null
 * when the research directory is not deployed alongside the server, which is
 * the normal production case — the constant above still pins the identity.
 */
export function computeFrozenConfigHash(freezePath = FREEZE_PATH): string | null {
  try {
    const raw = fs.readFileSync(freezePath);
    const lf = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"));
    return crypto.createHash("sha256").update(lf).digest("hex");
  } catch {
    return null;
  }
}

/** True when the on-disk freeze file still hashes to the pinned value. */
export function frozenConfigMatches(freezePath = FREEZE_PATH): boolean | null {
  const hash = computeFrozenConfigHash(freezePath);
  return hash === null ? null : hash === PATTERN_V1_CONFIG_HASH;
}

// ---------------------------------------------------------------- constants
// Verbatim from the research script. Do not adjust: this is a forward test of
// the frozen rule, and any change here invalidates the comparison.

export const PATTERN_V1_EXPIRY_MIN = 10;
export const PATTERN_V1_BB_PERIOD = 20;
export const PATTERN_V1_BB_K = 2.0;
export const PATTERN_V1_RSI_OS = 30;
export const PATTERN_V1_RSI_OB = 70;
export const PATTERN_V1_RSI_PERIOD = 14;
export const PATTERN_V1_ADX_PERIOD = 14;

/** The 12 instruments the research ran over. */
export const PATTERN_V1_SYMBOLS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD",
  "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD",
] as const;

/**
 * Bars of history the forward evaluator replays before trusting a signal.
 *
 * The re-entry state machine is stateful, so a trailing window could in
 * principle disagree with a full-history replay. It converges quickly because
 * the state resets every time price returns to the band mid, which on M1 is
 * frequent; the convergence test measures this rather than assuming it.
 */
export const PATTERN_V1_MIN_CANDLES = 300;

export type PatternV1Dir = "up" | "down";
export type RsiSeverity = "mild" | "medium" | "extreme";
export type AdxBucket = "le20" | "b20_25" | "b25_30" | "gt30";
export type PatternV1Branch = "V1A_EXTREME_ADX_GT30" | "V1B_MEDIUM_ADX_20_25";

export interface PatternCandle {
  /** Candle OPEN time, ISO-8601. The close is open + 60s — see closeMsOf. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ---------------------------------------------------------------- indicators
// Ported verbatim.

function trueRange(c: PatternCandle, prevClose: number) {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/** Bollinger with POPULATION standard deviation: mean(x^2) - mean(x)^2. */
export function computeBollinger(closes: Float64Array, period: number, k: number) {
  const n = closes.length;
  const mid = new Float64Array(n).fill(NaN);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = closes[i]!;
    sum += x;
    sumSq += x * x;
    if (i >= period) {
      const old = closes[i - period]!;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean);
      const sd = Math.sqrt(variance);
      mid[i] = mean;
      upper[i] = mean + k * sd;
      lower[i] = mean - k * sd;
    }
  }
  return { mid, upper, lower };
}

/** Wilder RSI(14). */
export function computeRsi14(closes: Float64Array) {
  const n = closes.length;
  const rsi = new Float64Array(n).fill(NaN);
  if (n < 15) return rsi;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / 14;
  let avgLoss = loss / 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
    avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

/** Wilder ADX(14). */
export function computeAdx14(candles: PatternCandle[]) {
  const n = candles.length;
  const adx = new Float64Array(n).fill(NaN);
  if (n < 29) return adx;
  const tr = new Float64Array(n);
  const plusDM = new Float64Array(n);
  const minusDM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr[i] = trueRange(c, p.close);
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  let atr = 0;
  let pDM = 0;
  let mDM = 0;
  for (let i = 1; i <= 14; i++) {
    atr += tr[i]!;
    pDM += plusDM[i]!;
    mDM += minusDM[i]!;
  }
  const dxArr: number[] = [];
  for (let i = 14; i < n; i++) {
    if (i > 14) {
      atr = atr - atr / 14 + tr[i]!;
      pDM = pDM - pDM / 14 + plusDM[i]!;
      mDM = mDM - mDM / 14 + minusDM[i]!;
    }
    const plusDI = atr > 0 ? (100 * pDM) / atr : 0;
    const minusDI = atr > 0 ? (100 * mDM) / atr : 0;
    const denom = plusDI + minusDI;
    const dx = denom > 0 ? (100 * Math.abs(plusDI - minusDI)) / denom : 0;
    dxArr.push(dx);
    if (dxArr.length === 14) adx[i] = dxArr.reduce((a, b) => a + b, 0) / 14;
    else if (dxArr.length > 14) adx[i] = (adx[i - 1]! * 13 + dx) / 14;
  }
  return adx;
}

/**
 * ADX bucket. Verbatim, including the non-finite case mapping to "gt30".
 *
 * That quirk is preserved rather than corrected because it is part of the
 * frozen definition. The forward engine makes it unreachable by refusing to
 * evaluate without enough warmup for a finite ADX — a data-availability
 * precondition, not a change to the boundary.
 */
export function adxBucketOf(adx: number): AdxBucket {
  if (!Number.isFinite(adx)) return "gt30";
  if (adx <= 20) return "le20";
  if (adx <= 25) return "b20_25";
  if (adx <= 30) return "b25_30";
  return "gt30";
}

/**
 * RSI severity. The bands are evaluated in order, so they do not overlap
 * despite `mild <= 5` and `medium <= 10` both being satisfied by beyond=3.
 */
export function rsiSeverityOf(dir: PatternV1Dir, rsi: number): RsiSeverity {
  const beyond = dir === "up" ? PATTERN_V1_RSI_OS - rsi : rsi - PATTERN_V1_RSI_OB;
  if (beyond <= 5) return "mild";
  if (beyond <= 10) return "medium";
  return "extreme";
}

/** How far past the threshold the RSI sits, in RSI points. */
export function rsiBeyondOf(dir: PatternV1Dir, rsi: number): number {
  return dir === "up" ? PATTERN_V1_RSI_OS - rsi : rsi - PATTERN_V1_RSI_OB;
}

/**
 * The frozen timestamp convention: a candle stamped at its OPEN time closes 60
 * seconds later. Every signal is stamped with the CLOSE, so a signal time is
 * always an instant at which the bar was fully formed.
 */
export function closeMsOf(candle: PatternCandle): number {
  return Date.parse(candle.time) + 60_000;
}

// ---------------------------------------------------------------- the rule

/**
 * Pattern V1 membership, on an already-generated BB re-entry signal.
 *
 * Ported from `matchesPattern()`. Both branches carry the `dir === "up"` test,
 * which is what makes the rule `UP AND (A OR B)` rather than `(UP AND A) OR B`.
 */
export function matchesPatternV1(signal: {
  dir: PatternV1Dir;
  rsiSeverity: RsiSeverity;
  adxBucket: AdxBucket;
}): PatternV1Branch | null {
  const branchA =
    signal.dir === "up" && signal.rsiSeverity === "extreme" && signal.adxBucket === "gt30";
  const branchB =
    signal.dir === "up" && signal.rsiSeverity === "medium" && signal.adxBucket === "b20_25";
  if (branchA) return "V1A_EXTREME_ADX_GT30";
  if (branchB) return "V1B_MEDIUM_ADX_20_25";
  return null;
}

// ---------------------------------------------------------------- signals

export interface BbReentrySignal {
  instrument: string;
  side: "upper" | "lower";
  dir: PatternV1Dir;
  /** The confirmation candle's close — the research entry convention. */
  close: number;
  /** Signal instant: the confirmation candle's CLOSE time, in epoch ms. */
  closeMs: number;
  barIndex: number;
  rsi: number;
  rsiSeverity: RsiSeverity;
  rsiBeyond: number;
  adx: number;
  adxBucket: AdxBucket;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
}

interface SideState { outside: boolean; signaled: boolean }

/**
 * Replay the BB re-entry state machine and return every signal in the window.
 *
 * Ported verbatim from `collectBbReentryRsi`. The episode dedup is the
 * `signaled` flag: once a side fires it cannot fire again until price returns
 * to the band mid, which is what the freeze file means by
 * "episode until mid return + new outside".
 *
 * Note that `signaled` is set on ANY re-entry, including one whose RSI failed
 * the threshold. That is the research behaviour and it is preserved.
 */
export function collectBbReentrySignals(
  instrument: string,
  candles: PatternCandle[],
): BbReentrySignal[] {
  const out: BbReentrySignal[] = [];
  const upper: SideState = { outside: false, signaled: false };
  const lower: SideState = { outside: false, signaled: false };

  const closes = new Float64Array(candles.map((c) => c.close));
  const bb = computeBollinger(closes, PATTERN_V1_BB_PERIOD, PATTERN_V1_BB_K);
  const rsi14 = computeRsi14(closes);
  const adx14 = computeAdx14(candles);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const mid = bb.mid[i]!;
    const up = bb.upper[i]!;
    const lo = bb.lower[i]!;
    if (!Number.isFinite(mid) || !Number.isFinite(up) || !Number.isFinite(lo)) continue;

    const adx = adx14[i]!;
    const rsi = rsi14[i]!;

    for (const [side, st] of [["upper", upper] as const, ["lower", lower] as const]) {
      if (st.signaled) {
        const reset =
          side === "upper" ? c.close <= mid || c.low <= mid : c.close >= mid || c.high >= mid;
        if (reset) {
          st.signaled = false;
          st.outside = false;
        }
      }
    }

    if (!upper.signaled && c.high > up) upper.outside = true;
    if (!lower.signaled && c.low < lo) lower.outside = true;

    const upperReentry = upper.outside && c.close <= up;
    const lowerReentry = lower.outside && c.close >= lo;

    if (upperReentry) {
      if (!upper.signaled) {
        if (Number.isFinite(rsi) && rsi >= PATTERN_V1_RSI_OB) {
          out.push({
            instrument, side: "upper", dir: "down",
            close: Number(c.close), closeMs: closeMsOf(c), barIndex: i,
            rsi, rsiSeverity: rsiSeverityOf("down", rsi), rsiBeyond: rsiBeyondOf("down", rsi),
            adx: Number.isFinite(adx) ? adx : NaN, adxBucket: adxBucketOf(adx),
            bbMid: mid, bbUpper: up, bbLower: lo,
          });
        }
        upper.signaled = true;
      }
      upper.outside = false;
    }

    if (lowerReentry) {
      if (!lower.signaled) {
        if (Number.isFinite(rsi) && rsi <= PATTERN_V1_RSI_OS) {
          out.push({
            instrument, side: "lower", dir: "up",
            close: Number(c.close), closeMs: closeMsOf(c), barIndex: i,
            rsi, rsiSeverity: rsiSeverityOf("up", rsi), rsiBeyond: rsiBeyondOf("up", rsi),
            adx: Number.isFinite(adx) ? adx : NaN, adxBucket: adxBucketOf(adx),
            bbMid: mid, bbUpper: up, bbLower: lo,
          });
        }
        lower.signaled = true;
      }
      lower.outside = false;
    }
  }

  return out;
}

export interface PatternV1Signal extends BbReentrySignal {
  branch: PatternV1Branch;
}

/** Every Pattern V1 signal in the window. */
export function collectPatternV1Signals(
  instrument: string,
  candles: PatternCandle[],
): PatternV1Signal[] {
  const signals: PatternV1Signal[] = [];
  for (const signal of collectBbReentrySignals(instrument, candles)) {
    const branch = matchesPatternV1(signal);
    if (branch) signals.push({ ...signal, branch });
  }
  return signals;
}

/**
 * Does Pattern V1 fire on the NEWEST closed candle in this window?
 *
 * The state machine is replayed over the whole window and only a signal landing
 * on the final bar is returned, so the answer is exactly what the research
 * evaluator would have produced for that bar. Every candle passed in must be
 * complete: the caller is responsible for excluding the forming bar, and this
 * function never looks beyond the array it is given, so no future value can
 * reach the decision.
 */
export function evaluatePatternV1OnLastClosedCandle(
  instrument: string,
  candles: PatternCandle[],
): PatternV1Signal | null {
  if (candles.length < PATTERN_V1_MIN_CANDLES) return null;
  const lastIndex = candles.length - 1;
  const signals = collectPatternV1Signals(instrument, candles);
  const onLast = signals.find((signal) => signal.barIndex === lastIndex);
  if (!onLast) return null;
  // Warmup guard: refuse a decision built on a non-finite indicator rather than
  // let adxBucketOf's NaN -> "gt30" fallback open a real prediction.
  if (!Number.isFinite(onLast.adx) || !Number.isFinite(onLast.rsi)) return null;
  return onLast;
}
