-- A clean, forward-only, direction-only Momentum cohort.
--
-- This table is intentionally separate from paper_strategy_trades and from
-- momentum_inversion_arms. It records the raw midpoint direction exactly ten
-- minutes after a valid Momentum signal; it never stores a trade result, is
-- not read by risk/execution/adaptive evidence, and therefore cannot affect
-- paper trading or strategy selection.

CREATE TABLE IF NOT EXISTS momentum_direction_10m_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id text NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code),
  decision_time timestamptz NOT NULL,
  strategy_version text NOT NULL,
  config_version text NOT NULL,
  session text,
  regime text,
  original_direction text NOT NULL CHECK (original_direction IN ('long', 'short')),

  -- Both prices are completed OANDA M1 midpoint closes. signal_close_at is the
  -- last completed M1 close at or before decision_time; mark_close_at is
  -- exactly ten minutes later. Neither bid/ask nor execution geometry belongs
  -- in this direction-only experiment.
  signal_close_at timestamptz,
  signal_mid numeric,
  mark_close_at timestamptz,
  mark_mid numeric,
  original_outcome text CHECK (original_outcome IN ('won', 'lost', 'tie')),
  inverse_outcome text CHECK (inverse_outcome IN ('won', 'lost', 'tie')),
  resolved_at timestamptz,

  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'excluded')),
  excluded_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A repeat cycle cannot create a second observation for one actual signal.
  UNIQUE (experiment_id, instrument, decision_time)
);

CREATE INDEX IF NOT EXISTS momentum_direction_10m_pending_idx
  ON momentum_direction_10m_observations (decision_time, instrument)
  WHERE status = 'pending';
