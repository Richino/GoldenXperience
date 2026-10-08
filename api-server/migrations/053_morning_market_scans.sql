-- Market selection only. Immutable completed snapshots, no orders or trade rows.
CREATE TABLE morning_market_scans (
  id uuid PRIMARY KEY,
  job_key text NOT NULL UNIQUE,
  date_et date NOT NULL,
  version text NOT NULL,
  source text NOT NULL CHECK (source IN ('scheduled', 'manual')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','CLOSED')),
  snapshot jsonb,
  error text
);
CREATE INDEX morning_market_scans_history ON morning_market_scans(started_at DESC);
CREATE TABLE morning_market_scan_current (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  scan_id uuid REFERENCES morning_market_scans(id),
  manual_requested_at timestamptz
);
INSERT INTO morning_market_scan_current(singleton) VALUES(true);
