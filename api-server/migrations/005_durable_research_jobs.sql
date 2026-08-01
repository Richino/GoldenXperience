CREATE TABLE IF NOT EXISTS durable_research_jobs (
  run_id uuid PRIMARY KEY REFERENCES research_runs(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code),
  months integer NOT NULL CHECK(months IN (12,36,60)),
  status text NOT NULL CHECK(status IN ('queued','running','complete','failed')) DEFAULT 'queued',
  phase text NOT NULL DEFAULT 'collect',
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS durable_research_jobs_available_idx
  ON durable_research_jobs (available_at, created_at)
  WHERE status IN ('queued','running');
