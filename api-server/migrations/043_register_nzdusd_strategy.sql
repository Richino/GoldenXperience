-- Frozen NZDUSD Pre-Range Breakout V1. Pair-specific, H1, long and short.
-- Existing family behavior and centralized risk settings remain unchanged.

ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN ('ema', 'breakout', 'momentum', 'meanrev', 'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy', 'audusd_strategy', 'nzdusd_strategy'));

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'nzdusd_strategy',
  'NZDUSD_PRE_RANGE_BREAKOUT_V1',
  'nzdusd-strategy-cfg-v1',
  '{
    "symbol": "NZD_USD",
    "timeframe": "H1",
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "preRangeStartUtcHour": 6,
    "preRangeEndUtcHour": 10,
    "signalOriginUtcHour": 11,
    "stopAtr": 1.0,
    "rewardR": 2.0,
    "maxHoldBars": 3,
    "bodyAtrMinimum": 0.50,
    "confidenceTagOnly": true,
    "executionEnabled": true,
    "adaptiveParametersMutable": false
  }'::jsonb,
  'active'
)
ON CONFLICT(family, config_version) DO NOTHING;

-- A signal key is independent of process lifetime and survives scheduler
-- retries, API retries, reconnects, and server restarts.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_nzdusd_signal_key_idx
  ON paper_strategy_trades((features->'nzdusdStrategy'->>'signalKey'))
  WHERE strategy_family = 'nzdusd_strategy';

COMMENT ON INDEX paper_strategy_nzdusd_signal_key_idx IS
  'Durable one-signal-per-UTC-day key for frozen nzdusd_strategy V1.';
