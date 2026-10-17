-- Append-only interpretation history, separate from the research evidence and approved plan records.
CREATE TABLE IF NOT EXISTS market_state_snapshots (
  id uuid PRIMARY KEY,
  instrument text NOT NULL REFERENCES instruments(code),
  research_id uuid NOT NULL REFERENCES market_research(id),
  engine_version text NOT NULL,
  input_hash text NOT NULL,
  quality_status text NOT NULL CHECK (quality_status IN ('VALID','PARTIAL','STALE','UNAVAILABLE')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND snapshot->>'schemaVersion'='1.0'),
  created_at timestamptz NOT NULL,
  UNIQUE (instrument, input_hash)
);
CREATE INDEX IF NOT EXISTS market_state_snapshots_latest_idx ON market_state_snapshots(instrument, research_id, created_at DESC);
