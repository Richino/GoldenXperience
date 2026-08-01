CREATE TABLE IF NOT EXISTS shadow_outcome_labels (
  evaluation_id uuid PRIMARY KEY REFERENCES strategy_evaluations(id) ON DELETE CASCADE,
  failed_condition text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('target_first','stop_first','unresolved','ambiguous')),
  labeled_at timestamptz NOT NULL DEFAULT now(),
  horizon_ends_at timestamptz NOT NULL,
  result_r numeric,
  max_favorable_r numeric,
  max_adverse_r numeric,
  method_version text NOT NULL DEFAULT 'single-required-failure-v1'
);

CREATE INDEX IF NOT EXISTS shadow_outcome_labels_condition_outcome_idx
  ON shadow_outcome_labels (failed_condition, outcome);
