ALTER TABLE strategy_evaluations
  DROP CONSTRAINT IF EXISTS strategy_evaluations_source_kind_check;

ALTER TABLE strategy_evaluations
  ADD CONSTRAINT strategy_evaluations_source_kind_check
  CHECK (source_kind IN ('historical', 'forward') OR source_kind LIKE 'holdout:%');

CREATE TABLE IF NOT EXISTS research_holdouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_experiment_id uuid NOT NULL REFERENCES research_experiments(id) ON DELETE RESTRICT,
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  run_id uuid UNIQUE REFERENCES research_runs(id) ON DELETE SET NULL,
  instrument text NOT NULL REFERENCES instruments(code),
  direction text NOT NULL CHECK (direction IN ('all', 'long', 'short')),
  sessions text[] NOT NULL CHECK (cardinality(sessions) > 0),
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  configuration jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  summary jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (range_end > range_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS research_holdouts_source_experiment_idx
  ON research_holdouts (source_experiment_id);

CREATE INDEX IF NOT EXISTS research_holdouts_owner_idx
  ON research_holdouts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_holdout_trades (
  holdout_id uuid NOT NULL REFERENCES research_holdouts(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES trade_candidates(id) ON DELETE CASCADE,
  execution_status text NOT NULL CHECK (execution_status IN ('accepted', 'overlapping')),
  blocked_by_candidate_id uuid REFERENCES trade_candidates(id) ON DELETE SET NULL,
  simulated_entry_at timestamptz,
  simulated_exit_at timestamptz,
  PRIMARY KEY (holdout_id, candidate_id)
);
