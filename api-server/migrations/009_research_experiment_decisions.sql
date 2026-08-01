ALTER TABLE research_experiments
  ADD COLUMN IF NOT EXISTS decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS decision_note text,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz;

CREATE INDEX IF NOT EXISTS research_experiments_decision_idx
  ON research_experiments (user_id, decision, created_at DESC);
