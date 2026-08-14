import { query, transaction } from "./database.js";
import { getPricing, getResearchCandles, OandaRequestError } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor, precisionFor, displayNameFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculateAtrValues, calculateEmaValues } from "../../frontend/src/lib/strategy/indicators.js";
import { getForexSessionStatus, NEW_YORK_TIME_ZONE } from "../../frontend/src/lib/strategy/session.js";
import { MAJOR_INSTRUMENTS, type Candle, type MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * The Binary Prediction engine.
 *
 * Given the market state at a moment, it predicts whether a symbol will be
 * ABOVE or BELOW its recorded entry price a fixed duration later (10 minutes in
 * V1). It is intentionally separate from the forex trading engine: it imports no
 * execution module, places no OANDA order, and creates no paper trade. It reads
 * shared market data and writes its own tables only.
 *
 * The priority is measurement, not sophistication: every prediction is stored
 * with the exact model, the features it saw, the entry price and time, the
 * intended expiration, the actual market timestamp used to resolve it, and the
 * result. Losses are kept; resolved predictions are never rewritten.
 */

export const BINARY_MODEL_NAME = "binary-baseline-v1";
export const BINARY_MODEL_VERSION = "1.0.0";
/** V1 horizon. Durations are stored per prediction, so 5m/15m are just other values. */
export const BINARY_HORIZON_SECONDS = 600;
/** Extra horizons priced at resolution for research, never changing the official result. */
export const BINARY_SECONDARY_HORIZONS = [300, 900] as const;
/** Below this heuristic score the model returns WAIT rather than forcing a prediction. */
export const BINARY_DEFAULT_THRESHOLD = 0.58;
/**
 * Tie band, in ticks of the instrument's display precision. 0 means a tie only
 * when entry and expiration price are equal at that precision — an honest, rare
 * outcome rather than one that swallows real fractional-pip moves.
 */
export const BINARY_TIE_TOLERANCE_TICKS = 0;
/** Minimum completed M1 candles before the model is allowed to form a view. */
const MIN_FEATURE_CANDLES = 25;
/** Distinct from the paper collector's advisory lock so the two never contend. */
const BINARY_LOCK = 24_100_002;
/**
 * A live OANDA tick is a better settlement mark than waiting for a completed M1
 * candle, but only when it was observed immediately after expiration. Older
 * overdue predictions must use historical candles so a restart never settles
 * yesterday's prediction at today's price.
 */
const LIVE_RESOLUTION_GRACE_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Pure, deterministic core (feature calc, model, classification, statistics).
// Exported for the test harness; none of this touches the database or network.
// ---------------------------------------------------------------------------

export type BinaryCandle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };

export type BinaryFeatures = {
  /** Signed momentum over N minutes, in pips (close vs close N candles back). */
  momentumPips: { m1: number | null; m5: number | null; m10: number | null; m15: number | null };
  /** The same, as a fraction of price, so it is comparable across instruments. */
  returnPct: { m1: number | null; m5: number | null; m10: number | null; m15: number | null };
  trend: "up" | "down" | "flat";
  emaFast: number | null;
  emaSlow: number | null;
  atrPips: number | null;
  /** Standard deviation of the last 15 one-minute pip changes. */
  volatilityPips: number | null;
  candle: { bodyPips: number; upperWickPips: number; lowerWickPips: number; bodyRatio: number } | null;
  distanceFromHighPips: number | null;
  distanceFromLowPips: number | null;
  spreadPips: number | null;
  session: string;
  hourEt: number;
  timeOfDayBucket: string;
  /** Reference close the features were computed against, for reproducibility. */
  referenceClose: number;
  referenceCloseTime: string;
};

export type BinaryQuote = { bid: number; ask: number; mid: number };

function pipsBetween(a: number, b: number, pip: number) {
  return (a - b) / pip;
}

function momentumOver(closes: number[], back: number, pip: number): number | null {
  if (closes.length <= back) return null;
  const last = closes[closes.length - 1]!;
  const prior = closes[closes.length - 1 - back]!;
  return pipsBetween(last, prior, pip);
}

function returnOver(closes: number[], back: number): number | null {
  if (closes.length <= back) return null;
  const last = closes[closes.length - 1]!;
  const prior = closes[closes.length - 1 - back]!;
  return prior === 0 ? null : (last - prior) / prior;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function timeOfDayBucketFor(hourEt: number) {
  const start = Math.floor(hourEt / 4) * 4;
  const end = start + 4;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(start)}-${pad(end)} ET`;
}

function hourInNewYork(at: Date) {
  const value = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(at);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Everything the model is allowed to see at prediction time. Computed only from
 * COMPLETED candles at or before `now` and the current quote, so it can never
 * leak information from after the prediction was made.
 */
export function computeBinaryFeatures(
  instrument: string,
  completedCandles: BinaryCandle[],
  quote: BinaryQuote | null,
  now: Date,
): BinaryFeatures | null {
  if (completedCandles.length < MIN_FEATURE_CANDLES) return null;
  const pip = pipSizeFor(instrument);
  const closes = completedCandles.map((candle) => candle.close);
  const last = completedCandles[completedCandles.length - 1]!;

  const emaFast = calculateEmaValues(closes, 9).at(-1) ?? null;
  const emaSlow = calculateEmaValues(closes, 21).at(-1) ?? null;
  const trend: BinaryFeatures["trend"] = emaFast !== null && emaSlow !== null
    ? emaFast > emaSlow ? "up" : emaFast < emaSlow ? "down" : "flat"
    : "flat";

  const atrValue = calculateAtrValues(completedCandles as unknown as Candle[], 14).at(-1) ?? null;
  const atrPips = atrValue === null ? null : atrValue / pip;

  const recentReturns: number[] = [];
  for (let index = Math.max(1, closes.length - 15); index < closes.length; index += 1) {
    recentReturns.push(pipsBetween(closes[index]!, closes[index - 1]!, pip));
  }
  const volatilityPips = standardDeviation(recentReturns);

  const range = last.high - last.low;
  const candle = range > 0
    ? {
        bodyPips: Math.abs(last.close - last.open) / pip,
        upperWickPips: (last.high - Math.max(last.open, last.close)) / pip,
        lowerWickPips: (Math.min(last.open, last.close) - last.low) / pip,
        bodyRatio: Math.abs(last.close - last.open) / range,
      }
    : null;

  const window = completedCandles.slice(-15);
  const recentHigh = Math.max(...window.map((c) => c.high));
  const recentLow = Math.min(...window.map((c) => c.low));
  const mid = quote?.mid ?? last.close;

  const hourEt = hourInNewYork(now);
  return {
    momentumPips: {
      m1: momentumOver(closes, 1, pip),
      m5: momentumOver(closes, 5, pip),
      m10: momentumOver(closes, 10, pip),
      m15: momentumOver(closes, 15, pip),
    },
    returnPct: {
      m1: returnOver(closes, 1),
      m5: returnOver(closes, 5),
      m10: returnOver(closes, 10),
      m15: returnOver(closes, 15),
    },
    trend,
    emaFast,
    emaSlow,
    atrPips,
    volatilityPips,
    candle,
    distanceFromHighPips: pipsBetween(recentHigh, mid, pip),
    distanceFromLowPips: pipsBetween(mid, recentLow, pip),
    spreadPips: quote ? pipsBetween(quote.ask, quote.bid, pip) : null,
    session: getForexSessionStatus(now).label,
    hourEt,
    timeOfDayBucket: timeOfDayBucketFor(hourEt),
    referenceClose: last.close,
    referenceCloseTime: last.time,
  };
}

export type BinaryDecision = { direction: "up" | "down" | "wait"; score: number; rationale: string };

export interface BinaryModel {
  name: string;
  version: string;
  scoreKind: "heuristic_score" | "probability";
  threshold: number;
  evaluate(features: BinaryFeatures): BinaryDecision;
}

/**
 * binary-baseline-v1: a deterministic momentum-and-trend heuristic.
 *
 * This is NOT a trained model and its confidence is NOT a calibrated
 * probability — it is a bounded score used only to decide whether the edge is
 * worth recording. Its whole job in V1 is to generate clean, honestly-labelled
 * forward-test data that a real model (binary-lightgbm-v1 / binary-xgboost-v1)
 * can later be measured against.
 */
export function createBaselineModel(threshold = BINARY_DEFAULT_THRESHOLD): BinaryModel {
  const SCALE = 1.5; // momentum, in ATRs over the window, that approaches full strength
  return {
    name: BINARY_MODEL_NAME,
    version: BINARY_MODEL_VERSION,
    scoreKind: "heuristic_score",
    threshold,
    evaluate(features) {
      const m5 = features.momentumPips.m5;
      const m15 = features.momentumPips.m15;
      const atr = features.atrPips;
      if (m5 === null || m15 === null || atr === null || atr <= 0) {
        return { direction: "wait", score: 0.5, rationale: "Insufficient data for a momentum reading." };
      }
      // Momentum normalised by volatility, so a 3-pip move on a calm pair and a
      // 3-pip move on a wild one are not treated as equal evidence.
      const signal = (0.6 * m5 + 0.4 * m15) / atr;
      let strength = Math.min(Math.abs(signal) / SCALE, 1);
      const direction: "up" | "down" = signal >= 0 ? "up" : "down";
      const trendAgrees = (direction === "up" && features.trend === "up") || (direction === "down" && features.trend === "down");
      // A signal fighting the short-term trend is discounted, not flipped.
      if (features.trend !== "flat" && !trendAgrees) strength *= 0.6;
      const score = 0.5 + 0.45 * strength;
      if (score < this.threshold) {
        return { direction: "wait", score, rationale: `Score ${score.toFixed(3)} below threshold ${this.threshold}.` };
      }
      return {
        direction,
        score,
        rationale: `${direction === "up" ? "Upward" : "Downward"} momentum ${signal.toFixed(2)} ATR${trendAgrees ? ", trend-aligned" : ""}.`,
      };
    },
  };
}

function roundToPrecision(value: number, precision: number) {
  return Number(value.toFixed(precision));
}

/** True when entry and expiration price are equal within the instrument's tie band. */
export function isBinaryTie(entry: number, resolution: number, precision: number, toleranceTicks = BINARY_TIE_TOLERANCE_TICKS) {
  const tolerance = toleranceTicks * 10 ** -precision;
  return Math.abs(roundToPrecision(resolution, precision) - roundToPrecision(entry, precision)) <= tolerance;
}

/**
 * The resolution rule. Ties are never silently folded into a win or a loss.
 *   UP  won when expiration price > entry, lost when < entry.
 *   DOWN won when expiration price < entry, lost when > entry.
 */
export function classifyBinaryResult(
  direction: "up" | "down",
  entry: number,
  resolution: number,
  precision: number,
  toleranceTicks = BINARY_TIE_TOLERANCE_TICKS,
): "won" | "lost" | "tie" {
  if (isBinaryTie(entry, resolution, precision, toleranceTicks)) return "tie";
  const higher = roundToPrecision(resolution, precision) > roundToPrecision(entry, precision);
  if (direction === "up") return higher ? "won" : "lost";
  return higher ? "lost" : "won";
}

/** Close time of an M1 candle whose OANDA `time` is its open time. */
function candleCloseTime(candle: BinaryCandle) {
  return new Date(new Date(candle.time).getTime() + 60_000);
}

/**
 * The earliest reliable price at or after a target instant, from completed M1
 * candles. This is what makes resolution durable: if the app was down at the
 * exact expiration, the first completed candle at or after it is used, and its
 * real timestamp is returned so nothing is passed off as the exact mark.
 */
export function resolutionPriceAtOrAfter(
  completedCandles: BinaryCandle[],
  target: Date,
): { price: number; time: string } | null {
  for (const candle of completedCandles) {
    const close = candleCloseTime(candle);
    if (close.getTime() >= target.getTime()) {
      return { price: candle.close, time: close.toISOString() };
    }
  }
  return null;
}

/** Secondary research horizons priced from the same candles, without touching the official result. */
export function computeSecondaryMarks(
  direction: "up" | "down",
  entry: number,
  precision: number,
  startAt: Date,
  completedCandles: BinaryCandle[],
  horizons: readonly number[] = BINARY_SECONDARY_HORIZONS,
) {
  const marks: Record<string, { price: number; priceTime: string; result: "won" | "lost" | "tie" }> = {};
  for (const seconds of horizons) {
    const target = new Date(startAt.getTime() + seconds * 1000);
    const mark = resolutionPriceAtOrAfter(completedCandles, target);
    if (!mark) continue;
    marks[`${seconds}s`] = {
      price: mark.price,
      priceTime: mark.time,
      result: classifyBinaryResult(direction, entry, mark.price, precision),
    };
  }
  return marks;
}

export type SecondaryMark = { price: number; priceTime: string; result: "won" | "lost" | "tie" };

/**
 * Combines already-recorded secondary marks with freshly computed ones, with the
 * EXISTING marks winning. A mark written at resolution (the 5m) is therefore
 * never altered by a later back-fill; the back-fill only adds horizons that had
 * not elapsed yet when the prediction resolved (the 15m).
 */
export function mergeSecondaryMarks(
  existing: Record<string, unknown> | null | undefined,
  fresh: Record<string, SecondaryMark>,
): Record<string, unknown> {
  return { ...fresh, ...(existing ?? {}) };
}

// ---------------------------------------------------------------------------
// Statistics (pure; computed from stored rows, never claiming significance).
// ---------------------------------------------------------------------------

export type BinaryStatRow = {
  instrument: string;
  direction: "up" | "down";
  status: string;
  result: "won" | "lost" | "tie" | null;
  confidence: number | string;
  session: string | null;
  model_version: string;
  start_at: string | Date;
};

export function binaryStats(rows: BinaryStatRow[]) {
  const resolved = rows.filter((row) => row.status === "resolved" && row.result !== null);
  const won = resolved.filter((row) => row.result === "won").length;
  const lost = resolved.filter((row) => row.result === "lost").length;
  const tie = resolved.filter((row) => row.result === "tie").length;
  const decided = won + lost;
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === "active").length,
    resolved: resolved.length,
    won,
    lost,
    tie,
    // Wins over decided predictions (ties excluded from the denominator), as a
    // fraction. Null until at least one prediction has decided a direction.
    winRate: decided > 0 ? won / decided : null,
    // Enough resolved to look at, not a significance claim — the UI shows counts.
    evidenceEligible: resolved.length >= 30,
  };
}

function scoreBucket(confidence: number) {
  if (!Number.isFinite(confidence)) return "unknown";
  const lower = Math.floor(confidence / 0.05) * 0.05;
  const upper = lower + 0.05;
  return `${lower.toFixed(2)}-${upper.toFixed(2)}`;
}

export function binaryBreakdown(rows: BinaryStatRow[], keyFor: (row: BinaryStatRow) => string) {
  const groups = new Map<string, BinaryStatRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([group, groupRows]) => ({ group, ...binaryStats(groupRows) }))
    .sort((a, b) => b.resolved - a.resolved || a.group.localeCompare(b.group));
}

export function binaryPerformanceBreakdowns(rows: BinaryStatRow[]) {
  return {
    symbol: binaryBreakdown(rows, (row) => row.instrument),
    direction: binaryBreakdown(rows, (row) => row.direction),
    session: binaryBreakdown(rows, (row) => row.session ?? "Unknown"),
    timeOfDay: binaryBreakdown(rows, (row) => timeOfDayBucketFor(hourInNewYork(new Date(row.start_at)))),
    score: binaryBreakdown(rows, (row) => scoreBucket(Number(row.confidence))),
    model: binaryBreakdown(rows, (row) => row.model_version),
  };
}

/** The three horizons compared side by side, labelled for the UI. */
export const BINARY_HORIZON_LABELS: Record<number, string> = { 300: "5m", 600: "10m", 900: "15m" };
const BINARY_REPORTED_HORIZONS = [300, 600, 900] as const;

export type HorizonResultRow = {
  status: string;
  /** Official result at the prediction's own horizon (duration_seconds). */
  result: "won" | "lost" | "tie" | null;
  durationSeconds: number;
  /** Prices/results captured at the other horizons, keyed like "300s"/"900s". */
  secondaryMarks: Record<string, { result?: "won" | "lost" | "tie" }> | null;
};

/**
 * Win rate at 5m / 10m / 15m over the SAME resolved predictions, so the horizons
 * can be compared like-for-like. Each prediction's official result counts at its
 * own horizon; the other horizons come from the secondary marks recorded at
 * resolution. `missing` counts predictions whose data at a horizon was never
 * captured (e.g. an M1 gap), so a horizon's win rate is never silently inflated
 * by a smaller, different sample. Win rate excludes ties from the denominator.
 */
export function binaryHorizonBreakdown(rows: HorizonResultRow[]) {
  return BINARY_REPORTED_HORIZONS.map((seconds) => {
    let won = 0;
    let lost = 0;
    let tie = 0;
    let missing = 0;
    for (const row of rows) {
      if (row.status !== "resolved") continue;
      const result = seconds === row.durationSeconds ? row.result : row.secondaryMarks?.[`${seconds}s`]?.result ?? null;
      if (result === "won") won += 1;
      else if (result === "lost") lost += 1;
      else if (result === "tie") tie += 1;
      else missing += 1;
    }
    const decided = won + lost;
    return {
      horizonSeconds: seconds,
      label: BINARY_HORIZON_LABELS[seconds] ?? `${seconds}s`,
      resolved: won + lost + tie,
      won,
      lost,
      tie,
      missing,
      winRate: decided > 0 ? won / decided : null,
      evidenceEligible: won + lost + tie >= 30,
    };
  });
}

// ---------------------------------------------------------------------------
// IO layer: model registration, evaluation/opening, durable resolution, reads.
// ---------------------------------------------------------------------------

function toBinaryCandles(candles: Awaited<ReturnType<typeof getResearchCandles>>): BinaryCandle[] {
  return candles.map((candle) => ({
    time: candle.time,
    open: candle.mid.open,
    high: candle.mid.high,
    low: candle.mid.low,
    close: candle.mid.close,
    volume: candle.volume,
    complete: candle.complete,
  }));
}

async function ownerUserId(): Promise<string | null> {
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
  return owner.rows[0]?.id ?? null;
}

/** The baseline model's row, created on first use so a version bump is code-only. */
async function ensureBinaryModel(): Promise<{ id: string; name: string; version: string }> {
  const configuration = JSON.stringify({
    kind: "deterministic_baseline",
    horizonSeconds: BINARY_HORIZON_SECONDS,
    scoreKind: "heuristic_score",
    threshold: BINARY_DEFAULT_THRESHOLD,
    note: "Momentum and short-term trend heuristic. Confidence is a bounded score, not a calibrated probability.",
  });
  const result = await query<{ id: string; name: string; version: string }>(
    `INSERT INTO binary_models(name,version,score_kind,configuration) VALUES($1,$2,'heuristic_score',$3::jsonb)
     ON CONFLICT(name,version) DO UPDATE SET configuration=EXCLUDED.configuration
     RETURNING id,name,version`,
    [BINARY_MODEL_NAME, BINARY_MODEL_VERSION, configuration],
  );
  return result.rows[0]!;
}

async function persistBinaryWatchSnapshot(
  instrument: string,
  model: { name: string; version: string },
  evaluatedAt: Date,
  dataStatus: "connected" | "unavailable" | "stale",
  decision: BinaryDecision | null,
  quote: BinaryQuote | null,
  features: BinaryFeatures | null,
) {
  const active = await query<{ id: string }>(
    "SELECT id FROM binary_predictions WHERE instrument=$1 AND status='active' ORDER BY created_at DESC LIMIT 1",
    [instrument],
  );
  const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null;
  await query(
    `INSERT INTO binary_watch_snapshots(instrument,model_name,model_version,evaluated_at,data_status,bias,score,score_kind,bid,ask,spread_pips,session,active_prediction_id,features)
     VALUES($1,$2,$3,$4,$5,$6,$7,'heuristic_score',$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT(instrument) DO UPDATE SET model_name=EXCLUDED.model_name,model_version=EXCLUDED.model_version,evaluated_at=EXCLUDED.evaluated_at,data_status=EXCLUDED.data_status,bias=EXCLUDED.bias,score=EXCLUDED.score,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread_pips=EXCLUDED.spread_pips,session=EXCLUDED.session,active_prediction_id=EXCLUDED.active_prediction_id,features=EXCLUDED.features,updated_at=now()`,
    [
      instrument,
      model.name,
      model.version,
      evaluatedAt.toISOString(),
      dataStatus,
      decision ? decision.direction : null,
      decision ? decision.score : null,
      quote?.bid ?? null,
      quote?.ask ?? null,
      spreadPips,
      getForexSessionStatus(evaluatedAt).label,
      active.rows[0]?.id ?? null,
      JSON.stringify(features ?? {}),
    ],
  );
}

async function openBinaryPrediction(
  userId: string,
  model: { id: string; name: string; version: string },
  instrument: string,
  quote: BinaryQuote,
  features: BinaryFeatures,
  decision: BinaryDecision,
  now: Date,
  durationSeconds = BINARY_HORIZON_SECONDS,
): Promise<string | null> {
  if (decision.direction === "wait") return null;
  const precision = precisionFor(instrument);
  const intendedExpiration = new Date(now.getTime() + durationSeconds * 1000);
  const marketContext = {
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    spreadPips: features.spreadPips,
    session: features.session,
    hourEt: features.hourEt,
    dataSource: "oanda",
    referenceCloseTime: features.referenceCloseTime,
    referenceClose: features.referenceClose,
  };
  return transaction(async (client) => {
    // Serialises openers so the "one active per (instrument, duration)" check and
    // the insert are atomic; the partial unique index is the backstop.
    await client.query("SELECT pg_advisory_xact_lock($1)", [BINARY_LOCK]);
    const existing = await client.query(
      "SELECT 1 FROM binary_predictions WHERE instrument=$1 AND duration_seconds=$2 AND status='active'",
      [instrument, durationSeconds],
    );
    if (existing.rowCount) return null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO binary_predictions(user_id,model_id,model_name,model_version,instrument,direction,start_at,entry_price,duration_seconds,intended_expiration,price_precision,tie_tolerance,confidence,score_kind,features,market_context)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'heuristic_score',$14::jsonb,$15::jsonb)
       RETURNING id`,
      [
        userId,
        model.id,
        model.name,
        model.version,
        instrument,
        decision.direction,
        now.toISOString(),
        quote.mid,
        durationSeconds,
        intendedExpiration.toISOString(),
        precision,
        BINARY_TIE_TOLERANCE_TICKS * 10 ** -precision,
        decision.score,
        JSON.stringify(features),
        JSON.stringify(marketContext),
      ],
    );
    return inserted.rows[0]?.id ?? null;
  });
}

type DuePredictionRow = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  entry_price: string;
  start_at: string;
  intended_expiration: string;
  duration_seconds: number;
  price_precision: number;
  tie_tolerance: string;
};

/**
 * Resolves every prediction whose intended expiration has passed and for which a
 * reliable price at or after that instant exists. Durable and idempotent:
 *
 *  - Durable: it re-scans all active-and-overdue rows every cycle, so a
 *    prediction that expired while the app was down is picked up on restart.
 *  - Idempotent: the UPDATE is guarded by `status='active'`, so a second run (or
 *    two overlapping runs) can never re-resolve a row or record it twice.
 *
 * The preferred price is a verified live OANDA tick observed just after the
 * intended expiration. If that short window is missed (for example after a
 * restart), the first completed M1 candle at or after expiration is used.
 * The actual source and timestamp are both stored for auditability.
 */
export async function resolveDueBinaryPredictions(): Promise<number> {
  const due = await query<DuePredictionRow>(
    `SELECT id,instrument,direction,entry_price,start_at,intended_expiration,duration_seconds,price_precision,tie_tolerance
     FROM binary_predictions WHERE status='active' AND intended_expiration <= now()
     ORDER BY intended_expiration`,
  );
  if (!due.rows.length) return 0;

  // Fetch all due instruments together. Only a connected OANDA response can
  // settle a prediction; getPricing deliberately falls back to mock quotes on
  // errors, which must never decide a real recorded outcome.
  const dueInstruments = [...new Set(due.rows.map((prediction) => prediction.instrument as MajorInstrument))];
  const livePrices = new Map<string, { price: number; time: string }>();
  try {
    const pricing = await getPricing(dueInstruments);
    if (pricing.status.state === "connected" && pricing.status.source === "oanda") {
      for (const quote of pricing.data) {
        const observedAt = new Date(quote.time);
        if (Number.isFinite(quote.mid) && !Number.isNaN(observedAt.getTime())) {
          livePrices.set(quote.instrument, { price: quote.mid, time: observedAt.toISOString() });
        }
      }
    }
  } catch (error) {
    // Historical candles below remain the durable fallback. Do not let one
    // transient quote request block resolution for every overdue prediction.
    console.warn("[binary] live resolution quote unavailable", error);
  }

  let resolved = 0;
  for (const prediction of due.rows) {
    const startAt = new Date(prediction.start_at);
    const intended = new Date(prediction.intended_expiration);
    const liveMark = livePrices.get(prediction.instrument);
    const liveMarkTime = liveMark ? new Date(liveMark.time) : null;
    const canUseLiveMark = Boolean(
      liveMarkTime
      && liveMarkTime.getTime() >= intended.getTime()
      && liveMarkTime.getTime() - intended.getTime() <= LIVE_RESOLUTION_GRACE_MS,
    );

    // Enough M1 candles to cover start → now even after a long downtime.
    const minutesSinceStart = Math.floor((Date.now() - startAt.getTime()) / 60_000);
    const count = Math.min(1500, Math.max(60, minutesSinceStart + 30));
    let completed: BinaryCandle[] = [];
    try {
      completed = toBinaryCandles(await getResearchCandles(prediction.instrument, "M1", count)).filter((candle) => candle.complete);
    } catch (error) {
      if (!(error instanceof OandaRequestError)) throw error;
      // A fresh, verified live mark is enough to settle. Candle history only
      // enriches secondary research marks in that case; it must not turn a
      // decisive live outcome back into an indefinite "resolving" state.
      if (!canUseLiveMark) continue;
    }
    const candleMark = resolutionPriceAtOrAfter(completed, intended);
    const mark = canUseLiveMark && liveMark && liveMarkTime
      ? { price: liveMark.price, time: liveMarkTime.toISOString(), source: "live_tick" as const }
      : candleMark
        ? { ...candleMark, source: "m1_candle" as const }
        : null;
    if (!mark) continue; // No candle at/after expiration yet — try again next cycle.

    const entry = Number(prediction.entry_price);
    const precision = Number(prediction.price_precision);
    const toleranceTicks = precision > 0 ? Math.round(Number(prediction.tie_tolerance) / 10 ** -precision) : 0;
    const result = classifyBinaryResult(prediction.direction, entry, mark.price, precision, toleranceTicks);
    const secondary = computeSecondaryMarks(prediction.direction, entry, precision, startAt, completed);

    const updated = await query<{ id: string }>(
      `UPDATE binary_predictions
       SET status='resolved',resolution_price=$2,resolution_price_time=$3,resolution_source=$4,resolved_at=now(),result=$5,secondary_marks=$6::jsonb,updated_at=now()
       WHERE id=$1 AND status='active'
       RETURNING id`,
      [prediction.id, mark.price, mark.time, mark.source, result, JSON.stringify(secondary)],
    );
    if (updated.rowCount) resolved += 1;
  }
  return resolved;
}

type BackfillRow = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  entry_price: string;
  start_at: string;
  price_precision: number;
  secondary_marks: Record<string, unknown> | null;
};

/**
 * Fills in secondary research horizons that could not be priced at resolution
 * because they had not elapsed yet. The 15m mark on a 10m prediction is the
 * motivating case: the prediction settles at 10m, so its 15m price only exists
 * five minutes later. Once that time has passed, this back-fills the missing mark
 * from historical candles.
 *
 * It writes ONLY secondary_marks, and existing marks are preserved (the earlier
 * 5m mark is never touched). The immutability trigger forbids changing direction,
 * entry, start, expiration or the decided result — so the official outcome is
 * untouched and this only completes the research picture. Bounded to recent rows
 * so a permanently un-gettable horizon (e.g. a weekend gap) is not retried
 * forever.
 */
export async function backfillBinarySecondaryMarks(limit = 50): Promise<number> {
  const horizons = [...BINARY_SECONDARY_HORIZONS];
  const maxHorizon = Math.max(...horizons); // internal constant; safe to inline in SQL
  const due = await query<BackfillRow>(
    `SELECT id,instrument,direction,entry_price,start_at,price_precision,secondary_marks
     FROM binary_predictions
     WHERE status='resolved'
       AND start_at <= now() - make_interval(secs => ${maxHorizon})
       AND start_at >= now() - interval '3 days'
       AND NOT jsonb_exists(secondary_marks, '${maxHorizon}s')
     ORDER BY resolved_at DESC NULLS LAST
     LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  let filled = 0;
  for (const row of due.rows) {
    const startAt = new Date(row.start_at);
    // A tight M1 window ending just past the last horizon, so the prediction's
    // age never inflates the candle count.
    const to = new Date(startAt.getTime() + (maxHorizon + 300) * 1000).toISOString();
    let completed: BinaryCandle[];
    try {
      completed = toBinaryCandles(await getResearchCandles(row.instrument, "M1", 60, { to })).filter((candle) => candle.complete);
    } catch (error) {
      if (!(error instanceof OandaRequestError)) throw error;
      continue;
    }
    const precision = Number(row.price_precision);
    const fresh = computeSecondaryMarks(row.direction, Number(row.entry_price), precision, startAt, completed, horizons);
    const existing = row.secondary_marks ?? {};
    const merged = mergeSecondaryMarks(existing, fresh);
    if (Object.keys(merged).length <= Object.keys(existing).length) continue; // nothing new to add yet
    await query(
      "UPDATE binary_predictions SET secondary_marks=$2::jsonb,updated_at=now() WHERE id=$1 AND status='resolved'",
      [row.id, JSON.stringify(merged)],
    );
    filled += 1;
  }
  return filled;
}

/**
 * One evaluation pass: resolve anything due, then (while the market is open) take
 * a fresh market read for each symbol, refresh its watchlist bias, and open a new
 * 10-minute prediction where the model has a signal and the symbol has none active.
 */
export async function collectBinaryCycle(): Promise<{ opened: number; resolved: number; evaluated: number; reason?: string }> {
  let resolved = 0;
  try {
    resolved = await resolveDueBinaryPredictions();
  } catch (error) {
    console.error("[binary] resolution failed", error);
  }
  // Late research horizons (e.g. the 15m mark on a 10m prediction) are captured
  // once they have elapsed. Runs regardless of session — it depends on time
  // passing, not the market being open.
  try {
    const filled = await backfillBinarySecondaryMarks();
    if (filled) console.log(`[binary] back-filled ${filled} late secondary marks`);
  } catch (error) {
    console.error("[binary] secondary back-fill failed", error);
  }

  const userId = await ownerUserId();
  if (!userId) return { opened: 0, resolved, evaluated: 0, reason: "Owner account is unavailable" };
  const model = await ensureBinaryModel();
  const engine = createBaselineModel();
  const now = new Date();
  const marketOpen = getForexSessionStatus(now).marketOpen;
  if (!marketOpen) return { opened: 0, resolved, evaluated: 0, reason: "Forex market closed" };

  const pricing = await getPricing([...MAJOR_INSTRUMENTS]);
  const quoteByInstrument = new Map(pricing.data.map((quote) => [quote.instrument, quote]));
  const pricingLive = pricing.status.state === "connected" && pricing.status.source === "oanda";

  let opened = 0;
  let evaluated = 0;
  for (const instrument of MAJOR_INSTRUMENTS) {
    const priceQuote = quoteByInstrument.get(instrument);
    const quote: BinaryQuote | null = priceQuote ? { bid: priceQuote.bid, ask: priceQuote.ask, mid: priceQuote.mid } : null;
    const quoteFresh = Boolean(priceQuote && Date.now() - new Date(priceQuote.time).getTime() <= 2 * 60_000);

    let features: BinaryFeatures | null = null;
    try {
      const candles = toBinaryCandles(await getResearchCandles(instrument, "M1", 80)).filter((candle) => candle.complete);
      features = computeBinaryFeatures(instrument, candles, quote, now);
    } catch (error) {
      if (!(error instanceof OandaRequestError)) throw error;
      features = null;
    }

    const dataStatus: "connected" | "unavailable" | "stale" =
      pricingLive && quoteFresh && features ? "connected" : "unavailable";
    const decision = features ? engine.evaluate(features) : null;
    await persistBinaryWatchSnapshot(instrument, model, now, dataStatus, decision, quote, features);
    evaluated += 1;

    // Fail closed: only a live, fresh read with computable features may open one.
    if (dataStatus !== "connected" || !decision || !features || !quote || decision.direction === "wait") continue;
    const id = await openBinaryPrediction(userId, model, instrument, quote, features, decision, now);
    if (id) opened += 1;
  }

  return { opened, resolved, evaluated };
}

// ---------------------------------------------------------------------------
// Read models for the API endpoints.
// ---------------------------------------------------------------------------

const PREDICTION_SELECT = `
  id, prediction_sequence::text AS "sequence", instrument, direction, status,
  model_name AS "modelName", model_version AS "modelVersion",
  created_at AS "createdAt", start_at AS "startAt", entry_price::float AS "entryPrice",
  duration_seconds AS "durationSeconds", intended_expiration AS "intendedExpiration",
  resolution_price::float AS "resolutionPrice", resolution_price_time AS "resolutionPriceTime",
  resolution_source AS "resolutionSource", resolved_at AS "resolvedAt", result,
  confidence::float AS confidence, score_kind AS "scoreKind", price_precision AS "pricePrecision"`;

/** Recent predictions for the dashboard "Recent Predictions" section. */
export async function recentBinaryPredictions(limit = 8) {
  const rows = await query(
    `SELECT ${PREDICTION_SELECT} FROM binary_predictions ORDER BY created_at DESC LIMIT $1`,
    [Math.min(50, Math.max(1, limit))],
  );
  return rows.rows;
}

/** Full prediction history for the Journal "Binary Predictions" tab. */
export async function binaryJournal(userId: string, limit = 500) {
  const rows = await query(
    `SELECT ${PREDICTION_SELECT} FROM binary_predictions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(2000, Math.max(1, limit))],
  );
  return rows.rows;
}

/** One prediction with its stored feature snapshot and market context. */
export async function binaryPredictionDetail(userId: string, id: string) {
  const rows = await query(
    `SELECT ${PREDICTION_SELECT}, features, market_context AS "marketContext", secondary_marks AS "secondaryMarks", error_reason AS "errorReason"
     FROM binary_predictions WHERE id=$1 AND user_id=$2`,
    [id, userId],
  );
  return rows.rows[0] ?? null;
}

/** Per-symbol Binary Watchlist view. */
export async function binaryWatchlistSnapshot() {
  const rows = await query(
    `SELECT watch.instrument, watch.model_name AS "modelName", watch.model_version AS "modelVersion",
            watch.evaluated_at AS "evaluatedAt", watch.data_status AS "dataStatus", watch.bias, watch.score::float AS score,
            watch.score_kind AS "scoreKind", watch.bid::float, watch.ask::float, watch.spread_pips::float AS "spreadPips",
            watch.session, watch.active_prediction_id AS "activePredictionId", watch.updated_at AS "updatedAt",
            prediction.direction AS "activeDirection", prediction.entry_price::float AS "activeEntry",
            prediction.start_at AS "activeStartAt", prediction.intended_expiration AS "activeExpiration"
     FROM binary_watch_snapshots watch
     LEFT JOIN binary_predictions prediction ON prediction.id = watch.active_prediction_id
     ORDER BY array_position($1::text[], watch.instrument)`,
    [[...MAJOR_INSTRUMENTS]],
  );
  const byInstrument = new Map(rows.rows.map((row) => [(row as { instrument: string }).instrument, row]));
  return MAJOR_INSTRUMENTS.map((instrument) => byInstrument.get(instrument) ?? {
    instrument,
    modelName: BINARY_MODEL_NAME,
    modelVersion: BINARY_MODEL_VERSION,
    evaluatedAt: null,
    dataStatus: "unavailable",
    bias: null,
    score: null,
    scoreKind: "heuristic_score",
    bid: null,
    ask: null,
    spreadPips: null,
    session: "Unavailable",
    activePredictionId: null,
    updatedAt: null,
  });
}

/** Performance analytics for the resolved prediction record. */
export async function binaryPerformance(userId?: string) {
  const rows = await query<BinaryStatRow & HorizonResultRow>(
    `SELECT instrument, direction, status, result, confidence, market_context->>'session' AS session, model_version, start_at,
            duration_seconds AS "durationSeconds", secondary_marks AS "secondaryMarks"
     FROM binary_predictions${userId ? " WHERE user_id=$1" : ""}`,
    userId ? [userId] : [],
  );
  return {
    model: { name: BINARY_MODEL_NAME, version: BINARY_MODEL_VERSION, scoreKind: "heuristic_score" as const },
    summary: binaryStats(rows.rows),
    breakdowns: binaryPerformanceBreakdowns(rows.rows),
    // Same predictions scored at 5m / 10m / 15m, so the horizons compare like-for-like.
    horizons: binaryHorizonBreakdown(rows.rows),
  };
}

/** Dashboard/journal helper: label a pair for display. */
export function binaryDisplayName(instrument: string) {
  return displayNameFor(instrument);
}
