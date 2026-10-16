-- Trade plans: analyse → approve → monitor → confirm → notify / execute.
-- Add-only. Nothing here touches existing tables; planned_setups stays live
-- until the new monitor replaces it.
--
-- The server (src/trade-plan-state.ts) is the authority for status changes.
-- trade_plan_transitions mirrors its table so the database refuses an
-- illegal status write even if a code path forgets to go through it.

CREATE TABLE IF NOT EXISTS trade_plan_transitions (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO trade_plan_transitions(from_status, to_status) VALUES
  ('DRAFT','PENDING_APPROVAL'), ('DRAFT','INVALIDATED'), ('DRAFT','EXPIRED'),
  ('PENDING_APPROVAL','APPROVED'), ('PENDING_APPROVAL','REJECTED'),
  ('PENDING_APPROVAL','INVALIDATED'), ('PENDING_APPROVAL','EXPIRED'),
  ('APPROVED','MONITORING'), ('APPROVED','PENDING_APPROVAL'), ('APPROVED','CANCELLED'),
  ('APPROVED','INVALIDATED'), ('APPROVED','EXPIRED'),
  ('MONITORING','CONFIRMED'), ('MONITORING','PENDING_APPROVAL'), ('MONITORING','CANCELLED'),
  ('MONITORING','INVALIDATED'), ('MONITORING','EXPIRED'),
  ('CONFIRMED','NOTIFIED'), ('CONFIRMED','EXECUTION_PENDING'), ('CONFIRMED','CANCELLED'),
  ('CONFIRMED','INVALIDATED'), ('CONFIRMED','EXPIRED'),
  ('NOTIFIED','CANCELLED'), ('NOTIFIED','EXPIRED'),
  ('EXECUTION_PENDING','ORDER_SUBMITTED'), ('EXECUTION_PENDING','EXECUTION_FAILED'),
  ('EXECUTION_PENDING','CANCELLED'), ('EXECUTION_PENDING','INVALIDATED'), ('EXECUTION_PENDING','EXPIRED'),
  ('ORDER_SUBMITTED','PARTIALLY_FILLED'), ('ORDER_SUBMITTED','FILLED'),
  ('ORDER_SUBMITTED','EXECUTION_FAILED'), ('ORDER_SUBMITTED','CANCELLED'),
  ('PARTIALLY_FILLED','FILLED'), ('PARTIALLY_FILLED','CLOSED'),
  ('FILLED','CLOSED')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS trade_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- BUY and SELL plans from one Analyze run share this id.
  analysis_id uuid NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code),
  direction text NOT NULL CHECK (direction IN ('BUY','SELL')),
  setup_type text NOT NULL CHECK (setup_type IN ('BREAKOUT_RETEST','SR_REVERSAL')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','PENDING_APPROVAL','APPROVED','MONITORING','CONFIRMED','NOTIFIED',
    'EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED','EXECUTION_FAILED',
    'CLOSED','REJECTED','CANCELLED','INVALIDATED','EXPIRED')),
  -- Material version of the plan. Approval binds to (plan_version, plan_hash);
  -- a material edit bumps it and voids the approval.
  plan_version integer NOT NULL DEFAULT 1 CHECK (plan_version >= 1),
  plan_hash text NOT NULL,
  -- Bumped on every write; status changes compare-and-swap on it.
  state_version bigint NOT NULL DEFAULT 1,
  monitoring_mode text CHECK (monitoring_mode IN ('NOTIFY','AUTO')),
  paused_at timestamptz,
  timeframe text NOT NULL,
  market_bias text NOT NULL,
  trend_classification text NOT NULL,
  entry_zone_low numeric NOT NULL CHECK (entry_zone_low > 0),
  entry_zone_high numeric NOT NULL CHECK (entry_zone_high >= entry_zone_low),
  stop_loss numeric CHECK (stop_loss > 0),
  take_profit numeric CHECK (take_profit > 0),
  reward_risk numeric CHECK (reward_risk > 0),
  max_risk_percent numeric NOT NULL CHECK (max_risk_percent > 0 AND max_risk_percent <= 5),
  -- Full plan body: trigger, confirmation rules, stop/target/sizing rules,
  -- spread & slippage limits, news restrictions, invalidation, explanation.
  plan jsonb NOT NULL,
  -- What the generator saw: inputs, candle/quote timestamps, config.
  analysis_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  strategy_version text NOT NULL,
  market_data_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (paused_at IS NULL OR status = 'MONITORING')
);

CREATE INDEX IF NOT EXISTS trade_plans_user_status_idx ON trade_plans(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_plans_active_idx ON trade_plans(instrument, status)
  WHERE status IN ('APPROVED','MONITORING','CONFIRMED','EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED');
CREATE INDEX IF NOT EXISTS trade_plans_expiry_idx ON trade_plans(expires_at)
  WHERE status IN ('DRAFT','PENDING_APPROVAL','APPROVED','MONITORING','CONFIRMED','NOTIFIED');
CREATE INDEX IF NOT EXISTS trade_plans_analysis_idx ON trade_plans(analysis_id);

-- Refuse a status write that is not in the transition table.
CREATE OR REPLACE FUNCTION trade_plans_check_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM trade_plan_transitions WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Illegal trade plan transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.instrument IS DISTINCT FROM OLD.instrument
     OR NEW.direction IS DISTINCT FROM OLD.direction THEN
    RAISE EXCEPTION 'Trade plan owner, pair and direction are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_plans_check_transition ON trade_plans;
CREATE TRIGGER trade_plans_check_transition BEFORE UPDATE ON trade_plans
  FOR EACH ROW EXECUTE FUNCTION trade_plans_check_transition();

-- One row per confirmation condition per plan version, with its own reason.
CREATE TABLE IF NOT EXISTS trade_plan_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  condition_key text NOT NULL,
  ordinal integer NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PASSED','FAILED','BLOCKED')),
  detail text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at timestamptz,
  UNIQUE (plan_id, plan_version, condition_key)
);

-- Approval of ONE plan version. Revoked when the plan is materially edited.
CREATE TABLE IF NOT EXISTS trade_plan_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  plan_hash text NOT NULL,
  monitoring_mode text NOT NULL CHECK (monitoring_mode IN ('NOTIFY','AUTO')),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS trade_plan_approvals_one_active
  ON trade_plan_approvals(plan_id) WHERE revoked_at IS NULL;

-- Append-only history of every status change and notable event.
CREATE TABLE IF NOT EXISTS trade_plan_events (
  id bigserial PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor text NOT NULL CHECK (actor IN ('user','monitor','executor','system')),
  reason text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_plan_events_plan_idx ON trade_plan_events(plan_id, id);

CREATE OR REPLACE FUNCTION trade_plan_events_immutable() RETURNS trigger AS $$
BEGIN
  -- Allow only the cascade from deleting the parent plan/user (trigger depth > 1).
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'trade_plan_events is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_plan_events_immutable ON trade_plan_events;
CREATE TRIGGER trade_plan_events_immutable BEFORE UPDATE OR DELETE ON trade_plan_events
  FOR EACH ROW EXECUTE FUNCTION trade_plan_events_immutable();

-- Monitor progress, persisted so a restarted worker resumes, plus a lease so
-- only one worker evaluates a plan at a time.
CREATE TABLE IF NOT EXISTS trade_plan_monitoring_state (
  plan_id uuid PRIMARY KEY REFERENCES trade_plans(id) ON DELETE CASCADE,
  lease_owner text,
  lease_expires_at timestamptz,
  stage text NOT NULL DEFAULT 'WAITING',
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_evaluated_at timestamptz,
  last_candle_time timestamptz,
  last_price numeric,
  last_price_at timestamptz,
  not_triggered_reason text,
  consecutive_errors integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One execution attempt per plan version; the idempotency key makes a
-- repeated trigger find the existing attempt instead of ordering again.
CREATE TABLE IF NOT EXISTS trade_plan_execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING','BLOCKED','SUBMITTING','SUBMITTED','UNKNOWN','ACCEPTED','REJECTED','FAILED','RECONCILED')),
  safety_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  request jsonb,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_plan_execution_attempts_plan_idx ON trade_plan_execution_attempts(plan_id, created_at);

-- Broker-side orders (entry and protective). Practice only, enforced here.
CREATE TABLE IF NOT EXISTS trade_plan_broker_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES trade_plan_execution_attempts(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker text NOT NULL DEFAULT 'OANDA' CHECK (broker = 'OANDA'),
  environment text NOT NULL DEFAULT 'practice' CHECK (environment = 'practice'),
  kind text NOT NULL CHECK (kind IN ('ENTRY','STOP_LOSS','TAKE_PROFIT')),
  client_order_id text NOT NULL UNIQUE,
  broker_order_id text,
  broker_trade_id text,
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN (
    'REQUESTED','PENDING','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN')),
  requested_units numeric,
  filled_units numeric,
  requested_price numeric,
  fill_price numeric,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_plan_broker_orders_plan_idx ON trade_plan_broker_orders(plan_id);

-- Links plan events to the existing notification_events history.
CREATE TABLE IF NOT EXISTS trade_plan_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  notification_id uuid REFERENCES notification_events(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  monitoring_mode text CHECK (monitoring_mode IN ('NOTIFY','AUTO')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, event_type)
);

-- Per-user limits. Auto execution stays off until the user approves these
-- limits (auto_limits_approved_at), and live money is locked off by CHECK.
CREATE TABLE IF NOT EXISTS trade_plan_risk_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_risk_percent numeric NOT NULL DEFAULT 1 CHECK (max_risk_percent > 0 AND max_risk_percent <= 5),
  max_aggregate_risk_percent numeric NOT NULL DEFAULT 3 CHECK (max_aggregate_risk_percent > 0 AND max_aggregate_risk_percent <= 20),
  max_open_positions integer NOT NULL DEFAULT 3 CHECK (max_open_positions BETWEEN 1 AND 20),
  daily_loss_limit_percent numeric NOT NULL DEFAULT 3 CHECK (daily_loss_limit_percent > 0 AND daily_loss_limit_percent <= 20),
  -- Spread and slippage as a fraction of the stop distance (pair-agnostic).
  max_spread_stop_fraction numeric NOT NULL DEFAULT 0.15 CHECK (max_spread_stop_fraction > 0 AND max_spread_stop_fraction <= 1),
  max_slippage_stop_fraction numeric NOT NULL DEFAULT 0.10 CHECK (max_slippage_stop_fraction > 0 AND max_slippage_stop_fraction <= 1),
  max_data_age_seconds integer NOT NULL DEFAULT 10 CHECK (max_data_age_seconds BETWEEN 1 AND 300),
  news_blackout_before_minutes integer NOT NULL DEFAULT 30 CHECK (news_blackout_before_minutes BETWEEN 0 AND 240),
  news_blackout_after_minutes integer NOT NULL DEFAULT 30 CHECK (news_blackout_after_minutes BETWEEN 0 AND 240),
  unprotected_fill_policy text NOT NULL DEFAULT 'CLOSE_POSITION' CHECK (unprotected_fill_policy IN ('CLOSE_POSITION','ALERT_ONLY')),
  broker_error_suspend_threshold integer NOT NULL DEFAULT 3 CHECK (broker_error_suspend_threshold BETWEEN 1 AND 20),
  consecutive_broker_errors integer NOT NULL DEFAULT 0,
  suspended_at timestamptz,
  suspended_reason text,
  kill_switch boolean NOT NULL DEFAULT false,
  auto_limits_approved_at timestamptz,
  live_trading_enabled boolean NOT NULL DEFAULT false CHECK (live_trading_enabled = false),
  notification_preferences jsonb NOT NULL DEFAULT '{"inApp":true,"push":true}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO trade_plan_risk_settings(user_id)
SELECT id FROM users WHERE role = 'owner'
ON CONFLICT (user_id) DO NOTHING;
