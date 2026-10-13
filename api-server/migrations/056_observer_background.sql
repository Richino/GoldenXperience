CREATE TABLE IF NOT EXISTS market_observer_watches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code),
  mode text NOT NULL CHECK (mode IN ('NORMAL','SWING')),
  enabled boolean NOT NULL DEFAULT false,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,instrument)
);
CREATE INDEX IF NOT EXISTS market_observer_watches_due
  ON market_observer_watches(next_scan_at) WHERE enabled;
