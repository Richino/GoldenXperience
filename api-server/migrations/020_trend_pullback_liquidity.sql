INSERT INTO strategy_versions(name, version, configuration)
VALUES (
  'deterministic-forex',
  'trend-pullback-liquidity-v1',
  '{"status":"active","mode":"automatic_paper_and_optional_practice","timeframes":["M15","H1","H4"],"direction":"confirmed_H1_higher_highs_lows_or_lower_highs_lows","pullback":"atr_normalized_into_mapped_liquidity","confirmation":"rejection_or_displacement","targetR":2,"newsBufferMinutes":30,"newsFailClosed":true,"prices":"oanda_bid_ask","forcedExitEt":"16:45","holding":"same_day","batchSize":100}'::jsonb
)
ON CONFLICT (name, version) DO UPDATE
SET configuration = EXCLUDED.configuration;

UPDATE strategy_versions
SET configuration = configuration || '{"status":"retired","disposition":"preserved_read_only"}'::jsonb
WHERE name = 'deterministic-forex'
  AND version IN ('macro-liquidity-v1', 'day-exploration-v1');

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_news_status_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_news_status_check
  CHECK (news_status IN ('not_evaluated','clear','high_impact','calendar_unavailable','calendar_stale','calendar_incomplete'));

CREATE TABLE IF NOT EXISTS paper_strategy_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  instrument text NOT NULL REFERENCES instruments(code),
  decision_time timestamptz NOT NULL,
  setup_status text NOT NULL CHECK (setup_status IN ('valid','developing','invalid','no_setup')),
  direction text CHECK (direction IN ('long','short')),
  entry numeric,
  stop numeric,
  target numeric,
  risk_reward numeric,
  rejection_reason text,
  trade_created boolean NOT NULL DEFAULT false,
  spread_pips numeric,
  conditions jsonb NOT NULL,
  features jsonb NOT NULL,
  paper_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(strategy_version_id, instrument, decision_time)
);

CREATE INDEX IF NOT EXISTS paper_strategy_evaluations_reason_idx
  ON paper_strategy_evaluations(strategy_version_id, rejection_reason, created_at DESC);
