-- Binary Prediction system.
--
-- A binary prediction is a directional forecast — will this symbol be ABOVE or
-- BELOW its recorded entry price a fixed duration later (10 minutes for V1)?
-- It is deliberately isolated from the forex engine: no stop, no target, no
-- position size, and it NEVER creates an OANDA order or a paper trade. These
-- tables share only the instruments catalog and the users table with the rest
-- of the app.
--
-- The record is an audit log first and a feature second. Once a prediction is
-- ACTIVE its direction, entry price, start time and intended expiration are
-- frozen (enforced by the trigger below), and a resolved result is never
-- rewritten. Losses are kept. Newer models never overwrite older predictions.

CREATE TABLE IF NOT EXISTS binary_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  -- 'heuristic_score' for V1: the confidence is a bounded heuristic, not a
  -- statistically calibrated probability. A real ML model would set 'probability'.
  score_kind text NOT NULL DEFAULT 'heuristic_score'
    CHECK (score_kind IN ('heuristic_score', 'probability')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

INSERT INTO binary_models (name, version, score_kind, configuration)
VALUES (
  'binary-baseline-v1',
  '1.0.0',
  'heuristic_score',
  '{"kind":"deterministic_baseline","horizonSeconds":600,"scoreKind":"heuristic_score","note":"Momentum and short-term trend heuristic. The confidence is a bounded score, not a calibrated probability. Replaceable by binary-lightgbm-v1 / binary-xgboost-v1 once enough forward data exists.","threshold":0.58}'::jsonb
)
ON CONFLICT (name, version) DO UPDATE
SET score_kind = EXCLUDED.score_kind,
    configuration = EXCLUDED.configuration;

CREATE SEQUENCE IF NOT EXISTS binary_prediction_sequence;

CREATE TABLE IF NOT EXISTS binary_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_sequence bigint UNIQUE NOT NULL DEFAULT nextval('binary_prediction_sequence'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES binary_models(id),
  -- Denormalised so a prediction always names the exact model that produced it,
  -- even if the binary_models row is later edited.
  model_name text NOT NULL,
  model_version text NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code),
  direction text NOT NULL CHECK (direction IN ('up', 'down')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved', 'error')),

  -- Immutable lifecycle timestamps and the locked entry price.
  created_at timestamptz NOT NULL DEFAULT now(),
  start_at timestamptz NOT NULL,
  entry_price numeric NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 600 CHECK (duration_seconds > 0),
  intended_expiration timestamptz NOT NULL,

  -- Resolution. resolution_price_time is the ACTUAL market timestamp the price
  -- was observed at, kept separate from intended_expiration so a price taken
  -- shortly after a downtime is never passed off as the exact expiration mark.
  resolution_price numeric,
  resolution_price_time timestamptz,
  resolution_source text CHECK (resolution_source IN ('m1_candle', 'live_tick')),
  resolved_at timestamptz,
  result text CHECK (result IN ('won', 'lost', 'tie')),

  -- The tie band actually applied, and the instrument precision it derives from,
  -- recorded per row so a result stays reproducible if defaults ever change.
  price_precision integer NOT NULL,
  tie_tolerance numeric NOT NULL DEFAULT 0,

  -- The model's bounded score and how to read it.
  confidence numeric NOT NULL,
  score_kind text NOT NULL DEFAULT 'heuristic_score',

  -- Everything the model saw at prediction time, and the market context around
  -- it. Deterministic and reproducible from information available at start_at.
  features jsonb NOT NULL,
  market_context jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Secondary research horizons (e.g. 5m / 15m) captured at resolution WITHOUT
  -- altering the official duration_seconds result.
  secondary_marks jsonb NOT NULL DEFAULT '{}'::jsonb,

  error_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active 10-minute prediction per symbol at a time (V1 contract). Scoped by
-- duration so a future 5m horizon can run alongside the 10m one without either
-- blocking the other.
CREATE UNIQUE INDEX IF NOT EXISTS binary_predictions_one_active_idx
  ON binary_predictions (instrument, duration_seconds) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS binary_predictions_due_idx
  ON binary_predictions (status, intended_expiration);
CREATE INDEX IF NOT EXISTS binary_predictions_sequence_idx
  ON binary_predictions (prediction_sequence DESC);
CREATE INDEX IF NOT EXISTS binary_predictions_instrument_idx
  ON binary_predictions (instrument, created_at DESC);

-- The audit guarantee, at the database rather than trusting every caller: once a
-- row exists its direction, locked entry, start, intended expiration and horizon
-- cannot be edited, and a decided result cannot be overwritten. Resolution only
-- ever writes the resolution_* / result / secondary_marks columns.
CREATE OR REPLACE FUNCTION binary_predictions_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.direction <> OLD.direction
     OR NEW.entry_price <> OLD.entry_price
     OR NEW.start_at <> OLD.start_at
     OR NEW.intended_expiration <> OLD.intended_expiration
     OR NEW.duration_seconds <> OLD.duration_seconds
     OR NEW.created_at <> OLD.created_at
     OR NEW.instrument <> OLD.instrument THEN
    RAISE EXCEPTION 'binary_predictions immutable fields cannot be modified (id=%)', OLD.id;
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'binary_predictions result is immutable once decided (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS binary_predictions_guard_trg ON binary_predictions;
CREATE TRIGGER binary_predictions_guard_trg
  BEFORE UPDATE ON binary_predictions
  FOR EACH ROW EXECUTE FUNCTION binary_predictions_guard();

-- Current per-symbol view for the Binary Watchlist: the model's live bias and
-- score, whether a prediction is active, and when the symbol is next eligible.
CREATE TABLE IF NOT EXISTS binary_watch_snapshots (
  instrument text PRIMARY KEY REFERENCES instruments(code),
  model_name text NOT NULL,
  model_version text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  data_status text NOT NULL CHECK (data_status IN ('connected', 'unavailable', 'stale')),
  bias text CHECK (bias IN ('up', 'down', 'wait')),
  score numeric,
  score_kind text NOT NULL DEFAULT 'heuristic_score',
  bid numeric,
  ask numeric,
  spread_pips numeric,
  session text NOT NULL,
  active_prediction_id uuid REFERENCES binary_predictions(id) ON DELETE SET NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
