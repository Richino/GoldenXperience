-- Momentum direction inversion (momentum-inversion-v1).
--
-- Records, per trade, WHAT THE STRATEGY PREDICTED versus WHAT THE ENGINE
-- ACTUALLY TRADED. Without this separation a later analyst cannot tell whether
-- a momentum LONG in the journal means "momentum predicted up" or "momentum
-- predicted down and the execution policy flipped it".
--
--   direction           unchanged — always the EXECUTED direction, so every
--                       existing resolver, risk query, journal and UI keeps
--                       working with no change at all
--   original_direction  what the strategy itself concluded
--   inverted            whether the execution policy flipped it
--   inversion_experiment_id  which experiment cohort the trade belongs to
--
-- Existing rows are left completely alone: original_direction stays NULL for
-- every historical trade, which is what makes "before inversion" and "after
-- inversion" separable by query rather than by memory. Batch #7 is untouched.
--
-- Nothing here is exposed by any UI query — every API select names its columns
-- explicitly, so these fields are visible only to research and audit.

ALTER TABLE paper_strategy_trades
  ADD COLUMN IF NOT EXISTS original_direction text
    CHECK (original_direction IN ('long', 'short')),
  ADD COLUMN IF NOT EXISTS inverted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inversion_experiment_id text;

-- Same separation on the evaluation row, so a suppressed/blocked candidate is
-- attributable to the same cohort as an executed one.
ALTER TABLE paper_strategy_evaluations
  ADD COLUMN IF NOT EXISTS original_direction text
    CHECK (original_direction IN ('long', 'short')),
  ADD COLUMN IF NOT EXISTS inverted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inversion_experiment_id text;

CREATE INDEX IF NOT EXISTS paper_strategy_trades_inversion_idx
  ON paper_strategy_trades (inversion_experiment_id, decision_time)
  WHERE inversion_experiment_id IS NOT NULL;

-- Durable activation boundary, so "before" and "after" is a fact in the
-- database rather than a timestamp someone has to remember.
CREATE TABLE IF NOT EXISTS experiment_activations (
  experiment_id text PRIMARY KEY,
  activated_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL
);
