CREATE TABLE IF NOT EXISTS notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('setup_ready', 'paper_opened', 'paper_closed', 'system_issue')),
  title text NOT NULL,
  message text NOT NULL,
  instrument text REFERENCES instruments(code) ON DELETE SET NULL,
  paper_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS notification_events_user_created_idx
  ON notification_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notification_events_unread_idx
  ON notification_events(user_id, created_at DESC)
  WHERE read_at IS NULL;
