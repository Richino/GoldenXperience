CREATE TABLE IF NOT EXISTS research_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  experiment_version text NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code),
  direction text NOT NULL CHECK (direction IN ('all', 'long', 'short')),
  sessions text[] NOT NULL CHECK (cardinality(sessions) > 0),
  lookback_months integer NOT NULL CHECK (lookback_months BETWEEN 1 AND 120),
  configuration jsonb NOT NULL,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_experiment_trades (
  experiment_id uuid NOT NULL REFERENCES research_experiments(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES trade_candidates(id) ON DELETE CASCADE,
  execution_status text NOT NULL CHECK (execution_status IN ('accepted', 'overlapping')),
  blocked_by_candidate_id uuid REFERENCES trade_candidates(id) ON DELETE SET NULL,
  simulated_entry_at timestamptz,
  simulated_exit_at timestamptz,
  PRIMARY KEY (experiment_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS research_experiments_owner_instrument_idx
  ON research_experiments (user_id, instrument, created_at DESC);
