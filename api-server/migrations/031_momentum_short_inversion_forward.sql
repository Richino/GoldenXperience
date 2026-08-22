-- Momentum SHORT inversion — forward shadow A/B experiment.
--
-- One row per REAL forward Momentum SHORT opportunity, holding BOTH arms:
--   A (original)  SHORT, filled at bid
--   B (inverted)  LONG,  filled at ask, same stop/target distances mirrored
--
-- Both arms are shadow only. Nothing here places an order, opens a paper
-- position, touches risk/exposure, or feeds the adaptive engine's evidence. The
-- adaptive engine reads shadow_candidate_outcomes and paper_strategy_trades;
-- this table is deliberately not one of them, so collection cannot influence
-- live selection while the hypothesis is frozen.
--
-- The discovery sample (2026-08-19 → 08-21, 23 momentum trades) is NOT in here
-- and must never be inserted: the sample that generated a hypothesis cannot also
-- confirm it. Rows begin only at experiment activation.

CREATE TABLE IF NOT EXISTS momentum_short_inversion_pairs (
  forward_pair_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- cohort label; a Momentum config change must start a NEW cohort rather than
  -- silently pooling evidence across two different strategies
  cohort text NOT NULL,
  strategy_version text NOT NULL,
  config_version text NOT NULL,

  instrument text NOT NULL,
  decision_time timestamptz NOT NULL,
  session text,
  regime text,
  atr numeric,
  atr_pips numeric,
  spread_pips numeric,

  -- geometry, identical for both arms
  stop_distance numeric NOT NULL,
  target_distance numeric NOT NULL,

  -- ARM A: the direction Momentum actually chose
  orig_direction text NOT NULL CHECK (orig_direction = 'short'),
  orig_entry numeric NOT NULL,
  orig_stop numeric NOT NULL,
  orig_target numeric NOT NULL,
  orig_outcome text,
  orig_result_r numeric,
  orig_mfe_r numeric,
  orig_mae_r numeric,
  orig_exit numeric,
  orig_resolved_at timestamptz,
  orig_exit_reason text,

  -- ARM B: the exact opposite, priced independently on the other side of the book
  inv_direction text NOT NULL CHECK (inv_direction = 'long'),
  inv_entry numeric NOT NULL,
  inv_stop numeric NOT NULL,
  inv_target numeric NOT NULL,
  inv_outcome text,
  inv_result_r numeric,
  inv_mfe_r numeric,
  inv_mae_r numeric,
  inv_exit numeric,
  inv_resolved_at timestamptz,
  inv_exit_reason text,

  -- fixed-horizon forward moves, filled at resolution: tells us whether the
  -- SHORT call is anti-predictive or whether the TP/SL geometry is doing it
  horizon_returns jsonb,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'excluded')),
  excluded_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,

  -- one pair per opportunity: re-evaluating the same bar cannot double-count
  UNIQUE (cohort, instrument, decision_time)
);

CREATE INDEX IF NOT EXISTS momentum_short_inversion_pending_idx
  ON momentum_short_inversion_pairs (status, decision_time);
CREATE INDEX IF NOT EXISTS momentum_short_inversion_cohort_idx
  ON momentum_short_inversion_pairs (cohort, status);
