-- Phase 3: adaptive model selection.
--
-- Separates model identity from user-facing authority. Historical rows keep
-- baseline authoritative; shadow rows remain non-authoritative.

ALTER TABLE binary_predictions
  ADD COLUMN IF NOT EXISTS is_authoritative boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN binary_predictions.is_authoritative IS
  'True for the single user-facing prediction per opportunity. Distinct from is_shadow.';

-- Backfill: baseline predictions were authoritative; shadow predictions were not.
UPDATE binary_predictions
SET is_authoritative = (is_shadow = false)
WHERE is_authoritative = false AND is_shadow = false;

CREATE INDEX IF NOT EXISTS binary_predictions_authoritative_idx
  ON binary_predictions (is_authoritative, created_at DESC)
  WHERE is_authoritative = true;

CREATE TABLE IF NOT EXISTS binary_selector_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),

  selector_version text NOT NULL,
  selector_state text NOT NULL CHECK (selector_state IN ('COLLECTING', 'LEARNING', 'ACTIVE_SELECTION')),

  recommended_model text NOT NULL,
  authoritative_model text NOT NULL,
  recommendation_only boolean NOT NULL DEFAULT true,
  fallback_used boolean NOT NULL DEFAULT false,
  reason text NOT NULL,

  evidence_scope text NOT NULL,
  sample_size integer NOT NULL DEFAULT 0,
  estimate numeric,
  ci_low numeric,
  ci_high numeric,

  regime_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  baseline_prediction_id uuid REFERENCES binary_predictions(id) ON DELETE SET NULL,
  logistic_prediction_id uuid REFERENCES binary_predictions(id) ON DELETE SET NULL,

  resolved_at timestamptz,
  recommended_model_correct boolean,
  authoritative_model_correct boolean,
  baseline_correct boolean,
  logistic_correct boolean,

  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS binary_selector_decisions_state_idx
  ON binary_selector_decisions (selector_state, created_at DESC);
CREATE INDEX IF NOT EXISTS binary_selector_decisions_unresolved_idx
  ON binary_selector_decisions (resolved_at)
  WHERE resolved_at IS NULL;
