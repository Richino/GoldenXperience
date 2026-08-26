-- Audit trail for the legacy-confidence-v2 daemon.
--
-- One row per pair per 15-minute cycle. Records what the detector saw, why it
-- did or did not fire, the model's probability output when it did fire, and the
-- final decision (baseline / inverted / skipped) — plus the raw indicator values
-- used for the decision so a human can independently verify any given cycle.
--
-- Written by src/legacy-confidence-v2-collector.ts on every cycle regardless of
-- LEGACY_CONFIDENCE_V2_DRY_RUN, so the audit trail is decoupled from whether
-- paper trades are actually opened. The `dry_run` column records which mode the
-- cycle ran in.
--
-- Size expectation: 12 pairs * 96 cycles/day = ~1150 rows/day = ~35k/month.
-- Prune with `DELETE FROM legacy_confidence_v2_evaluations WHERE evaluated_at < now() - interval '90 days'`
-- if the table ever gets uncomfortable.

CREATE TABLE IF NOT EXISTS legacy_confidence_v2_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id text NOT NULL,                                     -- shared across the 12 pairs of one cycle
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  m15_bar_time timestamptz,                                   -- close time of the M15 bar the detector used
  instrument text NOT NULL,
  dry_run boolean NOT NULL,

  -- detector result
  setup_passed boolean NOT NULL,
  reject_reason text,                                          -- null when setup_passed
  direction text,                                              -- long | short | null (only when passed)

  -- geometry (only when passed)
  entry numeric,
  stop numeric,
  target numeric,
  risk_pips numeric,
  target_pips numeric,

  -- indicator snapshot (all nullable — some may be unavailable when the
  -- detector short-circuits on insufficient candles)
  m15_ema21 numeric,
  m15_ema50 numeric,
  m15_ema200 numeric,
  h1_ema21 numeric,
  h1_ema50 numeric,
  h4_ema21 numeric,
  h4_ema50 numeric,
  atr14 numeric,
  atr_pips numeric,
  rsi14 numeric,
  spread_pips numeric,

  -- model output (only when detector passed)
  p_long numeric,
  features jsonb,
  artifact_version text,
  artifact_trained_at timestamptz,

  -- decision (only when detector passed)
  decision_action text,                                        -- take_baseline | take_model_pick | skip
  decision_reason text,
  executed_direction text,                                     -- final direction acted on (null when skipped)
  inverted boolean,                                            -- true when model flipped baseline

  -- link to the resulting paper trade (only when a trade was actually opened)
  trade_id uuid,

  error_message text                                           -- unexpected exception during evaluation
);

CREATE INDEX IF NOT EXISTS legacy_confidence_v2_evaluations_time_idx
  ON legacy_confidence_v2_evaluations (evaluated_at DESC);
CREATE INDEX IF NOT EXISTS legacy_confidence_v2_evaluations_pair_time_idx
  ON legacy_confidence_v2_evaluations (instrument, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS legacy_confidence_v2_evaluations_cycle_idx
  ON legacy_confidence_v2_evaluations (cycle_id);
CREATE INDEX IF NOT EXISTS legacy_confidence_v2_evaluations_passed_idx
  ON legacy_confidence_v2_evaluations (setup_passed) WHERE setup_passed;
