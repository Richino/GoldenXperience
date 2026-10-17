-- Versioned practice STOP/OCO runs. Existing version-2 news setups keep their lifecycle.
CREATE TABLE IF NOT EXISTS news_straddle_runs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code), event_key text NOT NULL,
  state text NOT NULL, revision integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL CHECK (snapshot->>'version'='3'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  UNIQUE(account_key,instrument,event_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS news_straddle_one_active_pair ON news_straddle_runs(account_key,instrument) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS news_straddle_active ON news_straddle_runs(account_key,state) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS news_straddle_audit (
  id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES news_straddle_runs(id),
  occurred_at timestamptz NOT NULL, event text NOT NULL, detail jsonb NOT NULL, broker_transaction_id text,
  UNIQUE(run_id,broker_transaction_id)
);
CREATE TABLE IF NOT EXISTS news_straddle_runtime (
  account_key text PRIMARY KEY, transaction_cursor text, halted boolean NOT NULL DEFAULT false,
  halt_reason text, updated_at timestamptz NOT NULL DEFAULT now()
);
