-- Stage 8: backend-monitored range-reversion plans (PLANNED → READY / INVALIDATED).
-- A plan is NOT an OANDA order; it is a watched setup. No auto-execution.
CREATE TABLE IF NOT EXISTS planned_setups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code),
  timeframe text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  status text NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED', 'READY', 'INVALIDATED', 'EXPIRED')),
  -- The frozen plan (entry zone, preferred, SL, TP, frozen S/R, trigger, …).
  plan jsonb NOT NULL,
  -- Deduplicated monitoring alert history.
  alerts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one live (PLANNED/READY) plan per user + instrument.
CREATE UNIQUE INDEX IF NOT EXISTS planned_setups_one_live_per_pair
  ON planned_setups(user_id, instrument)
  WHERE status IN ('PLANNED', 'READY');

CREATE INDEX IF NOT EXISTS planned_setups_user_status_idx
  ON planned_setups(user_id, status, created_at DESC);
