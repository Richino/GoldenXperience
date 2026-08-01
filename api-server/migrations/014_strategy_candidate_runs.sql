CREATE TABLE IF NOT EXISTS research_strategy_candidate_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  instrument text NOT NULL REFERENCES instruments(code),
  configuration jsonb NOT NULL,
  baseline_summary jsonb NOT NULL,
  candidate_summary jsonb NOT NULL,
  decision_status text NOT NULL CHECK (decision_status IN ('eligible','rejected','insufficient_sample')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (instrument = 'GBP_USD')
);

CREATE TABLE IF NOT EXISTS research_strategy_candidate_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_strategy_candidate_runs(id) ON DELETE CASCADE,
  decision_time timestamptz NOT NULL,
  sample_period text NOT NULL CHECK (sample_period IN ('development','holdout')),
  direction text NOT NULL CHECK (direction IN ('long','short')),
  entry numeric NOT NULL,
  stop numeric NOT NULL,
  target numeric NOT NULL,
  planned_r numeric NOT NULL,
  spread_pips numeric NOT NULL,
  outcome text NOT NULL,
  result_r numeric,
  resolved_at timestamptz,
  execution_status text NOT NULL CHECK (execution_status IN ('accepted','overlapping')),
  UNIQUE (run_id, decision_time)
);

CREATE INDEX IF NOT EXISTS research_strategy_candidate_trades_run_time_idx
  ON research_strategy_candidate_trades (run_id, decision_time);
