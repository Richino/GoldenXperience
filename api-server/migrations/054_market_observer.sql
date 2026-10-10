-- Separate from order execution and the frozen Pattern V1 experiment.
CREATE TABLE IF NOT EXISTS market_observer_plans (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code), version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('WATCHING','READY','TRIGGERED','PAUSED','INVALIDATED','EXPIRED','CLOSED')),
  plan jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, instrument, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS market_observer_one_active ON market_observer_plans(user_id,instrument)
  WHERE status IN ('WATCHING','READY','TRIGGERED','PAUSED');
CREATE TABLE IF NOT EXISTS market_observer_events (
  id bigserial PRIMARY KEY, plan_id uuid NOT NULL REFERENCES market_observer_plans(id) ON DELETE CASCADE,
  at timestamptz NOT NULL, status text NOT NULL, reason text NOT NULL, snapshot jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS market_observer_events_plan ON market_observer_events(plan_id,id DESC);
