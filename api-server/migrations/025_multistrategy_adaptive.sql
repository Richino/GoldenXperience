-- Multi-Strategy + Adaptive Engine (Phase 2).
--
-- Four independent deterministic strategies (EMA, Breakout, Momentum, Mean
-- Reversion) feed a candidate set; an adaptive engine selects at most one per
-- instrument and records the rest. This migration is strictly additive: it
-- registers the new tables and adds nullable attribution columns to the
-- existing paper tables. It does NOT touch, relabel, or delete any historical
-- row, batch, or strategy version, and it does NOT retire the current liquidity
-- strategy — that is a separate, later migration once the new pipeline is
-- verified. The binary prediction system is untouched.

-- A container that ties the four per-strategy cohorts into one comparable
-- experiment, so each family's sample can be measured independently.
CREATE TABLE IF NOT EXISTS strategy_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text UNIQUE NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'complete', 'archived')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable, versioned strategy configurations. Once a config version has
-- generated research or trades it must never change: a parameter change is a new
-- config version (EMA V2), so a historical trade is always reproducible from the
-- exact configuration that produced it.
CREATE TABLE IF NOT EXISTS strategy_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family text NOT NULL CHECK (family IN ('ema', 'breakout', 'momentum', 'meanrev')),
  strategy_version text NOT NULL,
  config_version text NOT NULL,
  configuration jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'shadow')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, config_version)
);

-- The configuration itself is frozen at the database, not merely trusted to
-- every caller. status may change (active -> retired, or a shadow challenger
-- promoted), but family/version/config_version/configuration cannot.
CREATE OR REPLACE FUNCTION strategy_configs_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.family <> OLD.family
     OR NEW.config_version <> OLD.config_version
     OR NEW.strategy_version <> OLD.strategy_version
     OR NEW.configuration::text <> OLD.configuration::text THEN
    RAISE EXCEPTION 'strategy_configs are immutable once created (id=%); create a new config_version instead', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS strategy_configs_guard_trg ON strategy_configs;
CREATE TRIGGER strategy_configs_guard_trg
  BEFORE UPDATE ON strategy_configs
  FOR EACH ROW EXECUTE FUNCTION strategy_configs_guard();

-- First-class attribution + regime dimensions on the trade record. Nullable and
-- additive: existing liquidity trades keep NULLs here and are unaffected. The
-- detailed per-family features still live in the features JSONB column.
ALTER TABLE paper_strategy_trades
  ADD COLUMN IF NOT EXISTS strategy_family text,
  ADD COLUMN IF NOT EXISTS config_version text,
  ADD COLUMN IF NOT EXISTS regime text,
  ADD COLUMN IF NOT EXISTS trend_strength numeric,
  ADD COLUMN IF NOT EXISTS volatility_bucket text,
  ADD COLUMN IF NOT EXISTS atr_pips numeric,
  ADD COLUMN IF NOT EXISTS experiment_id uuid REFERENCES strategy_experiments(id);

CREATE INDEX IF NOT EXISTS paper_strategy_trades_family_idx
  ON paper_strategy_trades (strategy_family, instrument, status);
CREATE INDEX IF NOT EXISTS paper_strategy_trades_experiment_idx
  ON paper_strategy_trades (experiment_id, strategy_family, status);

-- The same attribution on evaluations, so every candidate — including the ones
-- that were suppressed or blocked — is attributable and researchable.
ALTER TABLE paper_strategy_evaluations
  ADD COLUMN IF NOT EXISTS strategy_family text,
  ADD COLUMN IF NOT EXISTS config_version text,
  ADD COLUMN IF NOT EXISTS regime text,
  ADD COLUMN IF NOT EXISTS trend_strength numeric,
  ADD COLUMN IF NOT EXISTS volatility_bucket text,
  ADD COLUMN IF NOT EXISTS atr_pips numeric,
  ADD COLUMN IF NOT EXISTS experiment_id uuid REFERENCES strategy_experiments(id),
  -- How this candidate fared in the adaptive decision at its instrument.
  ADD COLUMN IF NOT EXISTS execution_status text;

-- Batch -> experiment/family linkage. Each family collects into its own batch
-- (batches are already scoped to strategy_version_id), tied together here.
ALTER TABLE paper_strategy_batches
  ADD COLUMN IF NOT EXISTS experiment_id uuid REFERENCES strategy_experiments(id),
  ADD COLUMN IF NOT EXISTS strategy_family text;

-- A per-(instrument, family) live view for the multi-strategy watchlist. Kept
-- as a SEPARATE table so the existing single-row-per-instrument
-- paper_watch_snapshots (and everything that reads it) is untouched.
CREATE TABLE IF NOT EXISTS multistrategy_watch_snapshots (
  instrument text NOT NULL REFERENCES instruments(code),
  strategy_family text NOT NULL,
  strategy_version text NOT NULL,
  config_version text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  data_status text NOT NULL CHECK (data_status IN ('connected', 'unavailable', 'stale')),
  setup_status text NOT NULL CHECK (setup_status IN ('valid', 'developing', 'invalid', 'no_setup')),
  direction text CHECK (direction IN ('long', 'short')),
  entry numeric,
  stop numeric,
  target numeric,
  risk_reward numeric,
  regime text,
  trend_strength numeric,
  volatility_bucket text,
  atr_pips numeric,
  session text NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  selection_reason text,
  bid numeric,
  ask numeric,
  spread_pips numeric,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument, strategy_family)
);

-- The auditable record of every adaptive decision: the whole candidate set, the
-- regime, the engine state, the evidence used, what was selected, what was
-- suppressed, and why (including a NONE decision). This is what makes it
-- possible to judge later whether the adaptive engine actually helped.
CREATE TABLE IF NOT EXISTS adaptive_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid REFERENCES strategy_experiments(id),
  instrument text NOT NULL REFERENCES instruments(code),
  decision_time timestamptz NOT NULL,
  adaptive_state text NOT NULL
    CHECK (adaptive_state IN ('collecting', 'learning', 'active_selection')),
  regime jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected jsonb,
  suppressed jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  selected_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument, decision_time)
);

CREATE INDEX IF NOT EXISTS adaptive_decisions_time_idx
  ON adaptive_decisions (decision_time DESC);
CREATE INDEX IF NOT EXISTS adaptive_decisions_experiment_idx
  ON adaptive_decisions (experiment_id, decision_time DESC);
