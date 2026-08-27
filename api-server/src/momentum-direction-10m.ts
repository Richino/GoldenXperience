import { query } from "./database.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

/** A fresh cohort; it is never backfilled from pre-existing trades or arms. */
export const MOMENTUM_DIRECTION_10M_EXPERIMENT = "momentum-direction-10m-v1";
const HORIZON_MS = 10 * 60_000;
const ELIGIBLE_FAMILY = "momentum";

type Direction = "long" | "short";
export type MidpointCandle = { closeTime: string; midClose: number };
export type DirectionOutcome = "won" | "lost" | "tie";

function iso(value: string | Date) { return new Date(value).toISOString(); }

function outcome(direction: Direction, move: number): DirectionOutcome {
  if (move === 0) return "tie";
  return (direction === "long" ? move > 0 : move < 0) ? "won" : "lost";
}

function inverse(outcomeValue: DirectionOutcome): DirectionOutcome {
  return outcomeValue === "won" ? "lost" : outcomeValue === "lost" ? "won" : "tie";
}

/**
 * Records one valid Momentum signal before selection and execution. This is
 * independent of whether the signal is later suppressed, blocked, or traded.
 */
export async function recordMomentumDirection10m(input: { candidate: StrategyCandidate; session: string }): Promise<"recorded" | "skipped"> {
  const { candidate } = input;
  if (candidate.family !== ELIGIBLE_FAMILY || candidate.status !== "valid" || candidate.direction === null) return "skipped";
  await query(
    `INSERT INTO momentum_direction_10m_observations
       (experiment_id, instrument, decision_time, strategy_version, config_version, session, regime, original_direction)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (experiment_id, instrument, decision_time) DO NOTHING`,
    [MOMENTUM_DIRECTION_10M_EXPERIMENT, candidate.instrument, candidate.evaluatedAt, candidate.version,
     candidate.configVersion, input.session, candidate.regime?.regime ?? null, candidate.direction],
  );
  return "recorded";
}

/**
 * Resolves only when both completed M1 midpoint closes exist. Missing or
 * discontinuous market data stays pending to retry; it is never guessed.
 */
export async function resolveMomentumDirection10m(
  candlesFor: (instrument: MajorInstrument) => Promise<MidpointCandle[]>,
  now = new Date(),
): Promise<number> {
  const pending = await query<{ id: string; instrument: MajorInstrument; decision_time: string | Date; original_direction: Direction }>(
    `SELECT id, instrument, decision_time, original_direction
       FROM momentum_direction_10m_observations
      WHERE experiment_id=$1 AND status='pending'
        AND decision_time <= $2::timestamptz - interval '10 minutes'
      ORDER BY instrument, decision_time
      LIMIT 300`,
    [MOMENTUM_DIRECTION_10M_EXPERIMENT, now.toISOString()],
  );
  const byInstrument = new Map<MajorInstrument, typeof pending.rows>();
  for (const row of pending.rows) byInstrument.set(row.instrument, [...(byInstrument.get(row.instrument) ?? []), row]);

  let resolved = 0;
  for (const [instrument, rows] of byInstrument) {
    let candles: Array<{ closeMs: number; midClose: number }>;
    try {
      candles = (await candlesFor(instrument))
        .map((candle) => ({ closeMs: Date.parse(candle.closeTime), midClose: candle.midClose }))
        .filter((candle) => Number.isFinite(candle.closeMs) && Number.isFinite(candle.midClose))
        .sort((left, right) => left.closeMs - right.closeMs);
    } catch (error) { console.error("[momentum-direction-10m] candles unavailable", instrument, error); continue; }

    for (const row of rows) {
      const decisionMs = new Date(row.decision_time).getTime();
      let signal: { closeMs: number; midClose: number } | null = null;
      for (const candle of candles) { if (candle.closeMs <= decisionMs) signal = candle; else break; }
      if (!signal) continue;
      const markAt = signal.closeMs + HORIZON_MS;
      if (markAt > now.getTime()) continue;
      const mark = candles.find((candle) => candle.closeMs === markAt);
      if (!mark) continue;
      const original = outcome(row.original_direction, mark.midClose - signal.midClose);
      const updated = await query(
        `UPDATE momentum_direction_10m_observations
            SET signal_close_at=$2, signal_mid=$3, mark_close_at=$4, mark_mid=$5,
                original_outcome=$6, inverse_outcome=$7, resolved_at=$8, status='resolved', updated_at=now()
          WHERE id=$1 AND status='pending'`,
        [row.id, new Date(signal.closeMs).toISOString(), signal.midClose, new Date(mark.closeMs).toISOString(), mark.midClose,
         original, inverse(original), now.toISOString()],
      );
      resolved += updated.rowCount ?? 0;
    }
  }
  return resolved;
}

export async function momentumDirection10mSummary() {
  const result = await query<{ recorded: string; resolved: string; original_wins: string; inverse_wins: string; ties: string }>(
    `SELECT count(*)::text AS recorded,
            count(*) FILTER (WHERE status='resolved')::text AS resolved,
            count(*) FILTER (WHERE original_outcome='won')::text AS original_wins,
            count(*) FILTER (WHERE inverse_outcome='won')::text AS inverse_wins,
            count(*) FILTER (WHERE original_outcome='tie')::text AS ties
       FROM momentum_direction_10m_observations
      WHERE experiment_id=$1`,
    [MOMENTUM_DIRECTION_10M_EXPERIMENT],
  );
  return result.rows[0] ?? { recorded: "0", resolved: "0", original_wins: "0", inverse_wins: "0", ties: "0" };
}

export const momentumDirection10mInternals = { outcome, inverse, HORIZON_MS, iso };
