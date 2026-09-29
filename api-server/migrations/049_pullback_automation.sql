-- Automate: per-pair server-side watch of the TrendPullbackV1 level for a
-- rejection or liquidity-sweep confirmation. Mode 'alert' notifies and waits
-- for Accept; mode 'auto' places the practice order itself.
CREATE TABLE IF NOT EXISTS pullback_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code),
  enabled boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'alert' CHECK (mode IN ('alert', 'auto')),
  -- Latest watch read (state, level, zone, reason) for the chart panel.
  last_watch jsonb,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, instrument)
);

-- One row per confirmation candle, whatever happened to it.
CREATE TABLE IF NOT EXISTS pullback_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument text NOT NULL REFERENCES instruments(code),
  mode text NOT NULL CHECK (mode IN ('alert', 'auto')),
  confirmation text NOT NULL CHECK (confirmation IN ('REJECTION', 'SWEEP')),
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  candle_time timestamptz NOT NULL,
  entry_price numeric NOT NULL,
  stop_price numeric NOT NULL,
  target_price numeric NOT NULL,
  spread_pips numeric NOT NULL,
  status text NOT NULL
    CHECK (status IN ('ALERTED', 'PLACED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SKIPPED', 'FAILED')),
  reason text NOT NULL,
  pending_entry_id uuid REFERENCES pending_manual_entries(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  watch jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, instrument, candle_time)
);

CREATE INDEX IF NOT EXISTS pullback_signals_user_pair_idx
  ON pullback_signals(user_id, instrument, created_at DESC);
