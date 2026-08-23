import { randomUUID } from "node:crypto";
import { query, transaction } from "./database.js";
import { getPricing, getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import {
  evaluatePatternV1OnLastClosedCandle, frozenConfigMatches,
  PATTERN_V1_CONFIG_HASH, PATTERN_V1_EXPIRY_MIN, PATTERN_V1_MIN_CANDLES,
  PATTERN_V1_SOURCE, PATTERN_V1_STRATEGY_ID, PATTERN_V1_STRATEGY_VERSION,
  PATTERN_V1_SYMBOLS, type PatternCandle, type PatternV1Signal,
} from "./pattern-v1.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * Pattern V1 forward paper engine.
 *
 * An INDEPENDENT background evaluator. It does not read, wait for, or depend on
 * the baseline binary engine in any way: it looks at every newly closed M1
 * candle for every supported symbol and opens its own 10-minute UP prediction
 * whenever the frozen rule fires. Baseline producing nothing at that instant is
 * irrelevant to it, and the two producing opposite calls on the same symbol at
 * the same minute is a valid, expected outcome worth recording.
 *
 * FROZEN. No adaptive selector, logistic model, inversion, confidence
 * suppression, threshold adjustment, symbol suppression or session suppression
 * may influence whether Pattern V1 fires. If the rule matches, the prediction
 * is recorded. That is the whole point of a forward test.
 *
 * PAPER ONLY: it writes a prediction row and nothing else. No order is placed.
 */

export const PATTERN_V1_DURATION_SECONDS = PATTERN_V1_EXPIRY_MIN * 60;

/** Bars requested per symbol. Comfortably above the replay window. */
const CANDLE_FETCH = 400;

export interface PatternV1CycleResult {
  evaluated: number;
  fired: number;
  opened: number;
  duplicates: number;
  reason?: string;
}

/** The registered model row, created by migration 035. */
async function patternModel(): Promise<{ id: string; name: string; version: string } | null> {
  const rows = await query<{ id: string; name: string; version: string }>(
    "SELECT id,name,version FROM binary_models WHERE name=$1 AND version=$2",
    [PATTERN_V1_STRATEGY_ID, PATTERN_V1_STRATEGY_VERSION],
  );
  return rows.rows[0] ?? null;
}

async function ownerUserId(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1",
  );
  return rows.rows[0]?.id ?? null;
}

/**
 * Open one Pattern V1 prediction.
 *
 * Entry price is the live mid at prediction time, the SAME convention the
 * baseline engine uses. The research recorded the signal candle's close, but
 * that is a price already in the past by the time the bar is known; taking it
 * forward would hand Pattern V1 an entry it could not have got. The signal is
 * identical to research; the fill is honest.
 *
 * Duplicate protection is the database's, not this function's: the partial
 * unique index on (model_name, instrument, signal_candle_time, duration) is
 * what makes a restart safe. The pre-check only avoids a pointless round trip.
 */
export async function openPatternV1Prediction(
  userId: string,
  model: { id: string; name: string; version: string },
  signal: PatternV1Signal,
  quote: { bid: number; ask: number; mid: number },
  now: Date,
): Promise<{ id: string } | "duplicate" | null> {
  const precision = precisionFor(signal.instrument);
  const intendedExpiration = new Date(now.getTime() + PATTERN_V1_DURATION_SECONDS * 1000);
  const signalCandleTime = new Date(signal.closeMs).toISOString();

  const inferenceContext = {
    strategy: PATTERN_V1_STRATEGY_ID,
    source: PATTERN_V1_SOURCE,
    configHash: PATTERN_V1_CONFIG_HASH,
    branch: signal.branch,
    rsi: signal.rsi,
    rsiSeverity: signal.rsiSeverity,
    rsiBeyond: signal.rsiBeyond,
    adx: signal.adx,
    adxBucket: signal.adxBucket,
    bbMid: signal.bbMid,
    bbUpper: signal.bbUpper,
    bbLower: signal.bbLower,
    bbReentry: { side: signal.side, signalCandleClose: signal.close },
    signalCandleTime,
    // The research entry, kept beside the live fill so the two are comparable
    // later without implying the forward trade got the research price.
    researchEntryClose: signal.close,
  };

  const marketContext = {
    bid: quote.bid, ask: quote.ask, mid: quote.mid,
    dataSource: "oanda",
    signalCandleTime,
    session: getForexSessionStatus(now).entrySession,
  };

  try {
    return await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO binary_predictions(
           user_id,model_id,model_name,model_version,instrument,direction,start_at,entry_price,
           duration_seconds,intended_expiration,price_precision,tie_tolerance,confidence,score_kind,
           features,market_context,opportunity_id,is_shadow,is_authoritative,inference_context,
           signal_candle_time,strategy_source,pattern_config_hash)
         VALUES($1,$2,$3,$4,$5,'up',$6,$7,$8,$9,$10,0,$11,'heuristic_score',
                $12::jsonb,$13::jsonb,$14,false,false,$15::jsonb,$16,$17,$18)
         ON CONFLICT (model_name, instrument, signal_candle_time, duration_seconds)
           WHERE signal_candle_time IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          userId, model.id, model.name, model.version, signal.instrument,
          now.toISOString(), quote.mid,
          PATTERN_V1_DURATION_SECONDS, intendedExpiration.toISOString(), precision,
          // A frozen rule has no score to report; 1 records "the rule matched"
          // rather than implying a calibrated probability.
          1,
          JSON.stringify(inferenceContext), JSON.stringify(marketContext), randomUUID(),
          JSON.stringify(inferenceContext),
          signalCandleTime, PATTERN_V1_SOURCE, PATTERN_V1_CONFIG_HASH,
        ],
      );
      const id = inserted.rows[0]?.id;
      return id ? { id } : "duplicate";
    });
  } catch (error) {
    console.error("[pattern-v1] insert failed", signal.instrument, error);
    return null;
  }
}

/**
 * One Pattern V1 evaluation pass over every supported symbol.
 *
 * Runs on its own, on the same 60-second cadence as the binary collector but
 * through a separate code path, so nothing about baseline's decision can reach
 * it. Only COMPLETED candles are used: the forming bar is filtered out before
 * the evaluator sees anything, and the evaluator itself never indexes past the
 * array it is given, so no future price can influence a decision.
 */
export async function collectPatternV1Cycle(now = new Date()): Promise<PatternV1CycleResult> {
  const result: PatternV1CycleResult = { evaluated: 0, fired: 0, opened: 0, duplicates: 0 };

  const session = getForexSessionStatus(now);
  if (!session.marketOpen) return { ...result, reason: "Forex market closed" };

  const userId = await ownerUserId();
  if (!userId) return { ...result, reason: "Owner account is unavailable" };
  const model = await patternModel();
  if (!model) return { ...result, reason: "Pattern V1 model is not registered (run migration 035)" };

  let pricing;
  try {
    pricing = await getPricing([...PATTERN_V1_SYMBOLS] as MajorInstrument[]);
  } catch (error) {
    console.error("[pattern-v1] pricing failed", error);
    return { ...result, reason: "Pricing unavailable" };
  }
  if (pricing.status.state !== "connected" || pricing.status.source !== "oanda") {
    return { ...result, reason: "Live OANDA pricing unavailable" };
  }
  const quoteByInstrument = new Map(pricing.data.map((quote) => [quote.instrument, quote]));

  for (const instrument of PATTERN_V1_SYMBOLS) {
    const quote = quoteByInstrument.get(instrument);
    if (!quote) continue;

    let candles: PatternCandle[];
    try {
      const fetched = await getResearchCandles(instrument, "M1", CANDLE_FETCH);
      // The forming bar is dropped here, before anything is computed from it.
      // Mid prices, matching the research cache the pattern was fitted on.
      candles = fetched
        .filter((candle) => candle.complete)
        .map((candle) => ({
          time: candle.time,
          open: candle.mid.open,
          high: candle.mid.high,
          low: candle.mid.low,
          close: candle.mid.close,
        }));
    } catch (error) {
      console.error("[pattern-v1] candles failed", instrument, error);
      continue;
    }
    if (candles.length < PATTERN_V1_MIN_CANDLES) continue;
    result.evaluated += 1;

    const signal = evaluatePatternV1OnLastClosedCandle(instrument, candles);
    if (!signal) continue;
    result.fired += 1;

    const opened = await openPatternV1Prediction(
      userId, model, signal,
      { bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2 },
      now,
    );
    if (opened === "duplicate") {
      result.duplicates += 1;
    } else if (opened) {
      result.opened += 1;
      console.log(JSON.stringify({
        event: "pattern.v1.opened",
        instrument, branch: signal.branch,
        rsi: Number(signal.rsi.toFixed(4)), rsiSeverity: signal.rsiSeverity,
        adx: Number(signal.adx.toFixed(4)), adxBucket: signal.adxBucket,
        signalCandleTime: new Date(signal.closeMs).toISOString(),
        entry: quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : null,
      }));
    }
  }

  return result;
}

// ---------------------------------------------------------------- status

/** Forward sample-size checkpoints. */
export const PATTERN_V1_CHECKPOINTS = [25, 50, 100, 250, 500] as const;

export function nextCheckpoint(resolved: number): number | null {
  return PATTERN_V1_CHECKPOINTS.find((mark) => mark > resolved) ?? null;
}

/**
 * Expected value at an 80% payout.
 *
 * EV80 = winRate * 0.80 - lossRate. Ties are excluded from both rates, which
 * matches how the existing binary statistics treat them: a tie returns the
 * stake and is neither a win nor a loss.
 */
export function ev80(wins: number, losses: number): number | null {
  const decided = wins + losses;
  if (!decided) return null;
  return (wins / decided) * 0.8 - losses / decided;
}

export interface PatternV1Status {
  strategy: string;
  version: string;
  source: string;
  configHash: string;
  configVerified: boolean | null;
  startedAt: string | null;
  total: number;
  pending: number;
  resolved: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
  ev80: number | null;
  nextCheckpoint: number | null;
  branches: Array<{ branch: string; n: number; wins: number; losses: number; ties: number; winRate: number | null }>;
}

/**
 * Read-only Pattern V1 forward status.
 *
 * Counts ONLY rows this engine produced. The historical TRAIN+DEV 61.75% and
 * SEALED HOLDOUT 55.96% are research results and deliberately do not appear
 * here: the forward counter starts at zero and reports only what has actually
 * happened since activation.
 */
export async function patternV1Status(userId?: string): Promise<PatternV1Status> {
  const scope = userId ? " AND user_id=$2" : "";
  const params: unknown[] = [PATTERN_V1_STRATEGY_ID];
  if (userId) params.push(userId);

  const totals = await query<{
    total: string; pending: string; resolved: string; wins: string; losses: string; ties: string; started: string | null;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status='active')::text AS pending,
            count(*) FILTER (WHERE result IS NOT NULL)::text AS resolved,
            count(*) FILTER (WHERE result='won')::text AS wins,
            count(*) FILTER (WHERE result='lost')::text AS losses,
            count(*) FILTER (WHERE result='tie')::text AS ties,
            min(created_at)::text AS started
     FROM binary_predictions WHERE model_name=$1${scope}`,
    params,
  );
  const row = totals.rows[0]!;
  const wins = Number(row.wins);
  const losses = Number(row.losses);
  const decided = wins + losses;

  const branchRows = await query<{ branch: string; n: string; wins: string; losses: string; ties: string }>(
    `SELECT inference_context->>'branch' AS branch,
            count(*)::text AS n,
            count(*) FILTER (WHERE result='won')::text AS wins,
            count(*) FILTER (WHERE result='lost')::text AS losses,
            count(*) FILTER (WHERE result='tie')::text AS ties
     FROM binary_predictions
     WHERE model_name=$1${scope} AND inference_context->>'branch' IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    params,
  );

  return {
    strategy: PATTERN_V1_STRATEGY_ID,
    version: PATTERN_V1_STRATEGY_VERSION,
    source: PATTERN_V1_SOURCE,
    configHash: PATTERN_V1_CONFIG_HASH,
    configVerified: frozenConfigMatches(),
    startedAt: row.started,
    total: Number(row.total),
    pending: Number(row.pending),
    resolved: Number(row.resolved),
    wins, losses, ties: Number(row.ties),
    winRate: decided ? wins / decided : null,
    ev80: ev80(wins, losses),
    nextCheckpoint: nextCheckpoint(Number(row.resolved)),
    branches: branchRows.rows.map((branch) => {
      const bWins = Number(branch.wins);
      const bLosses = Number(branch.losses);
      const bDecided = bWins + bLosses;
      return {
        branch: branch.branch,
        n: Number(branch.n),
        wins: bWins, losses: bLosses, ties: Number(branch.ties),
        winRate: bDecided ? bWins / bDecided : null,
      };
    }),
  };
}

/**
 * Diagnostic only: where baseline and Pattern V1 landed on the same symbol and
 * minute. Neither strategy reads this, and it can change no decision.
 */
export async function patternV1Disagreement(userId?: string) {
  const scope = userId ? " AND p.user_id=$1" : "";
  const params = userId ? [userId] : [];
  const rows = await query<{ kind: string; n: string }>(
    `WITH pattern AS (
       SELECT instrument, date_trunc('minute', start_at) AS minute, direction
       FROM binary_predictions p WHERE model_name='binary-pattern-v1'${scope}
     ), baseline AS (
       SELECT instrument, date_trunc('minute', start_at) AS minute, direction
       FROM binary_predictions p WHERE model_name='binary-baseline-v1'${scope}
     )
     SELECT CASE
              WHEN b.direction IS NULL THEN 'PATTERN_ONLY'
              WHEN p.direction IS NULL THEN 'BASELINE_ONLY'
              WHEN p.direction = b.direction THEN 'AGREE'
              ELSE 'DISAGREE'
            END AS kind,
            count(*)::text AS n
     FROM pattern p FULL OUTER JOIN baseline b
       ON b.instrument = p.instrument AND b.minute = p.minute
     GROUP BY 1 ORDER BY 1`,
    params,
  );
  return Object.fromEntries(rows.rows.map((row) => [row.kind, Number(row.n)]));
}
