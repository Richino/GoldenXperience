ALTER TABLE outcome_labels
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE trade_candidates
  ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'pending'
    CHECK (execution_status IN ('pending', 'accepted', 'overlapping')),
  ADD COLUMN IF NOT EXISTS blocked_by_candidate_id uuid REFERENCES trade_candidates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS simulated_entry_at timestamptz,
  ADD COLUMN IF NOT EXISTS simulated_exit_at timestamptz;

CREATE INDEX IF NOT EXISTS trade_candidates_execution_status_idx
  ON trade_candidates (execution_status, evaluation_id);
