CREATE TABLE IF NOT EXISTS pending_manual_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code),
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  entry_price numeric NOT NULL CHECK (entry_price > 0),
  entry_order_type text NOT NULL CHECK (entry_order_type IN ('buy_stop', 'buy_limit', 'sell_stop', 'sell_limit')),
  current_price_at_creation numeric NOT NULL CHECK (current_price_at_creation > 0),
  expiration_type text NOT NULL DEFAULT 'none' CHECK (expiration_type IN ('none', 'time')),
  expires_at timestamptz,
  invalidation_price numeric CHECK (invalidation_price > 0),
  invalidation_side text CHECK (invalidation_side IN ('above', 'below')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'TRIGGERING', 'TRIGGERED', 'EXPIRED', 'INVALIDATED', 'CANCELLED', 'FAILED')),
  trigger_price numeric,
  stop_price numeric,
  target_price numeric,
  paper_trade_id uuid REFERENCES paper_trades(id) ON DELETE SET NULL,
  failure_reason text,
  last_observed_price numeric,
  last_observed_at timestamptz,
  triggered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((expiration_type = 'none' AND expires_at IS NULL) OR (expiration_type = 'time' AND expires_at IS NOT NULL)),
  CHECK ((invalidation_price IS NULL AND invalidation_side IS NULL) OR (invalidation_price IS NOT NULL AND invalidation_side IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS pending_manual_entries_user_status_idx
  ON pending_manual_entries(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS pending_manual_entries_monitor_idx
  ON pending_manual_entries(instrument, status, created_at)
  WHERE status IN ('PENDING', 'TRIGGERING');

