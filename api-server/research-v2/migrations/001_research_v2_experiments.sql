-- Optional durable experiment registry (file registry.jsonl is primary).
-- Apply manually if you want DB-backed history:
--   psql $DATABASE_URL -f research-v2/migrations/001_research_v2_experiments.sql

CREATE TABLE IF NOT EXISTS research_v2_experiments (
  experiment_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  sealed_touched BOOLEAN NOT NULL DEFAULT false,
  candidate_id TEXT
);

CREATE INDEX IF NOT EXISTS research_v2_experiments_status_idx
  ON research_v2_experiments (status);

CREATE TABLE IF NOT EXISTS research_v2_candidates (
  candidate_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL DEFAULT 'SHADOW_ONLY',
  payload JSONB NOT NULL
);
