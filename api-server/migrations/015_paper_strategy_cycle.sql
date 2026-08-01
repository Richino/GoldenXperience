INSERT INTO instruments(code, display_name, price_precision)
VALUES
  ('EUR_USD', 'EUR/USD', 5),
  ('GBP_USD', 'GBP/USD', 5),
  ('USD_JPY', 'USD/JPY', 3),
  ('AUD_USD', 'AUD/USD', 5),
  ('NZD_USD', 'NZD/USD', 5),
  ('USD_CAD', 'USD/CAD', 5),
  ('USD_CHF', 'USD/CHF', 5),
  ('EUR_GBP', 'EUR/GBP', 5),
  ('EUR_JPY', 'EUR/JPY', 3),
  ('GBP_JPY', 'GBP/JPY', 3)
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name,
    price_precision = EXCLUDED.price_precision;

INSERT INTO strategy_versions(name, version, configuration)
VALUES (
  'deterministic-forex',
  'day-exploration-v1',
  '{"status":"active","mode":"automatic_paper_research","timeframes":["M15","H1","H4"],"entryWindowEt":"03:00-12:00","forcedExitEt":"16:45","holding":"same_day","targetR":1.5,"minimumRiskReward":null,"news":"not_evaluated","prices":"oanda_bid_ask","riskPercent":1,"paperOnly":true}'::jsonb
)
ON CONFLICT (name, version) DO UPDATE
SET configuration = EXCLUDED.configuration;

UPDATE strategy_versions
SET configuration = configuration || '{"status":"retired","disposition":"preserved_read_only"}'::jsonb
WHERE name = 'deterministic-forex'
  AND version <> 'day-exploration-v1'
  AND configuration->>'status' = 'active';

CREATE TABLE IF NOT EXISTS paper_strategy_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number integer UNIQUE NOT NULL CHECK (batch_number > 0),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  universe jsonb NOT NULL,
  configuration jsonb NOT NULL,
  status text NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'resolving', 'complete')),
  assigned_count integer NOT NULL DEFAULT 0 CHECK (assigned_count BETWEEN 0 AND 100),
  summary jsonb,
  recommendation jsonb,
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'rejected', 'not_applicable')),
  decision_note text,
  decided_at timestamptz,
  applied_to_batch_id uuid REFERENCES paper_strategy_batches(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE SEQUENCE IF NOT EXISTS paper_strategy_trade_sequence;

CREATE TABLE IF NOT EXISTS paper_strategy_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES paper_strategy_batches(id),
  trade_sequence bigint UNIQUE NOT NULL DEFAULT nextval('paper_strategy_trade_sequence'),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  instrument text NOT NULL REFERENCES instruments(code),
  decision_time timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'ambiguous')),
  outcome text NOT NULL DEFAULT 'open'
    CHECK (outcome IN ('open', 'target_first', 'stop_first', 'forced_close', 'ambiguous')),
  entry numeric NOT NULL,
  stop numeric NOT NULL,
  target numeric NOT NULL,
  exit numeric,
  planned_r numeric NOT NULL,
  result_r numeric,
  nominal_risk_percent numeric NOT NULL,
  nominal_risk_amount numeric NOT NULL,
  calculated_units numeric NOT NULL,
  calculated_standard_lots numeric NOT NULL,
  paper_pl numeric,
  spread_pips numeric NOT NULL,
  session text NOT NULL,
  weekday text NOT NULL,
  setup_name text NOT NULL,
  checklist_score numeric NOT NULL,
  conditions jsonb NOT NULL,
  features jsonb NOT NULL,
  news_status text NOT NULL DEFAULT 'not_evaluated'
    CHECK (news_status = 'not_evaluated'),
  rule_compliance text NOT NULL DEFAULT 'automatic'
    CHECK (rule_compliance IN ('automatic', 'reviewed')),
  review jsonb NOT NULL DEFAULT '{}'::jsonb,
  screenshot_before_url text,
  screenshot_after_url text,
  max_favorable_r numeric,
  max_adverse_r numeric,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  exit_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_version_id, instrument, decision_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_one_open_pair_idx
  ON paper_strategy_trades(instrument) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS paper_strategy_trades_batch_idx
  ON paper_strategy_trades(batch_id, trade_sequence);
CREATE INDEX IF NOT EXISTS paper_strategy_trades_open_idx
  ON paper_strategy_trades(status, instrument, opened_at);

CREATE TABLE IF NOT EXISTS paper_watch_snapshots (
  instrument text PRIMARY KEY REFERENCES instruments(code),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  evaluated_at timestamptz NOT NULL,
  data_status text NOT NULL CHECK (data_status IN ('connected', 'unavailable', 'stale')),
  setup_status text NOT NULL CHECK (setup_status IN ('valid', 'developing', 'invalid', 'no_setup')),
  direction text CHECK (direction IN ('long', 'short')),
  bid numeric,
  ask numeric,
  spread_pips numeric,
  entry numeric,
  stop numeric,
  target numeric,
  session text NOT NULL,
  conditions jsonb NOT NULL,
  features jsonb NOT NULL,
  open_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,
  batch_number integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_watch_snapshots_updated_idx
  ON paper_watch_snapshots(updated_at DESC);
