-- Stage-1-only EUR/USD shadow observations. These rows have no direction,
-- trade, position size, or link to the paper-risk engine.
CREATE TABLE IF NOT EXISTS eur_usd_move_gate_v1_shadow_observations (
  decision_time timestamptz PRIMARY KEY,
  instrument text NOT NULL CHECK (instrument = 'EUR_USD'),
  action text NOT NULL CHECK (action IN ('MOVE', 'WAIT')),
  reason text NOT NULL,
  atr numeric NOT NULL CHECK (atr > 0),
  bid_close numeric NOT NULL CHECK (bid_close > 0),
  ask_close numeric NOT NULL CHECK (ask_close > 0),
  expected_move_atr numeric,
  cost_atr numeric,
  movement_strength numeric,
  volatility_expansion numeric,
  compression_release numeric,
  velocity_atr numeric,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  outcome text CHECK (outcome IN ('move_target_first', 'no_move_target_first')),
  horizon_ends_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending' AND outcome IS NULL AND resolved_at IS NULL)
      OR (status = 'resolved' AND outcome IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS eur_usd_move_gate_v1_shadow_pending_idx
  ON eur_usd_move_gate_v1_shadow_observations (status, decision_time);
