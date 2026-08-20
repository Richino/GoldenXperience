-- Phase 1: multi-model shadow collection for binary predictions.
--
-- Adds opportunity linkage so baseline and shadow models evaluated on the same
-- market snapshot can be compared later. Shadow rows are stored in the same
-- binary_predictions table but filtered from normal user-facing reads.
--
-- The partial unique index is scoped by model_name so baseline and shadow
-- predictions can both be active on the same instrument and horizon.

ALTER TABLE binary_predictions
  ADD COLUMN IF NOT EXISTS opportunity_id uuid,
  ADD COLUMN IF NOT EXISTS is_shadow boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inference_context jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN binary_predictions.opportunity_id IS
  'Links sibling predictions (baseline + shadow) evaluated on the same market snapshot.';
COMMENT ON COLUMN binary_predictions.is_shadow IS
  'True for research shadow models that must not affect user-facing binary UX.';
COMMENT ON COLUMN binary_predictions.inference_context IS
  'Model-specific debug/research fields (e.g. rawProbabilityUp for logistic).';

-- Replace the one-active-per-symbol index with one scoped per model.
DROP INDEX IF EXISTS binary_predictions_one_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS binary_predictions_one_active_idx
  ON binary_predictions (instrument, duration_seconds, model_name)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS binary_predictions_opportunity_idx
  ON binary_predictions (opportunity_id)
  WHERE opportunity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS binary_predictions_shadow_idx
  ON binary_predictions (is_shadow, model_name, created_at DESC)
  WHERE is_shadow = true;

-- Register the shadow logistic model (configuration is informational; runtime uses the frozen artifact).
INSERT INTO binary_models (name, version, score_kind, configuration)
VALUES (
  'binary-logistic-v1',
  '1.0.0',
  'probability',
  '{"kind":"logistic_regression","horizonSeconds":600,"scoreKind":"probability","note":"Shadow-only L2 logistic regression trained on stored binary features. Not used for trading or model selection in Phase 1.","artifact":"src/data/binary-logistic-v1.json"}'::jsonb
)
ON CONFLICT (name, version) DO UPDATE
SET score_kind = EXCLUDED.score_kind,
    configuration = EXCLUDED.configuration;
