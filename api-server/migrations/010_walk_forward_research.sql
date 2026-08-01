CREATE TABLE IF NOT EXISTS research_walk_forward_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  instrument text NOT NULL REFERENCES instruments(code),
  configuration jsonb NOT NULL,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_walk_forward_owner_instrument_idx
  ON research_walk_forward_runs (user_id, instrument, created_at DESC);
