CREATE TABLE IF NOT EXISTS practice_execution_policies (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO practice_execution_policies(user_id)
SELECT id FROM users WHERE role='owner'
ON CONFLICT(user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS practice_order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_trade_id uuid NOT NULL UNIQUE REFERENCES paper_strategy_trades(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','submitted','failed','unknown','disabled')),
  broker_order_id text,
  broker_trade_id text,
  request_payload jsonb NOT NULL,
  failure_reason text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS practice_order_intents_pending_idx
  ON practice_order_intents(status, created_at)
  WHERE status = 'pending';
