-- Public market discovery only. No account, order or trade records.
CREATE TABLE IF NOT EXISTS pair_trend_snapshots (
  snapshot_key text PRIMARY KEY,
  checked_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
