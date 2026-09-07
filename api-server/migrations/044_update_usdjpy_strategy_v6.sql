-- Replace only the USDJPY pair strategy configuration with frozen V6.
-- This is a paper/research registration; applying the migration does not deploy code.

UPDATE strategy_configs
SET status = 'retired'
WHERE family = 'usdjpy_strategy'
  AND config_version <> 'usdjpy-strategy-cfg-v6'
  AND status = 'active';

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'usdjpy_strategy',
  'v6',
  'usdjpy-strategy-cfg-v6',
  '{
    "symbol": "USD_JPY",
    "timeframe": "H1",
    "direction": "long_only",
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "preRangeStartUtcHour": 8,
    "preRangeEndUtcHour": 10,
    "entryWindowStartUtcHour": 11,
    "entryWindowEndUtcHour": 14,
    "minimumBodyAtr": 0.40,
    "extremeClosePct": 0.40,
    "stopAtr": 1.0,
    "rewardR": 2.0,
    "maxHoldBars": 3,
    "maximumTradesPerUtcDay": 1,
    "setup": "USDJPY_BODY_EXTREME",
    "executionEnabled": true,
    "adaptiveParametersMutable": false
  }'::jsonb,
  'active'
)
ON CONFLICT(family, config_version) DO UPDATE
SET status = EXCLUDED.status;

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_usdjpy_daily_signal_idx
  ON paper_strategy_trades((features->'usdjpyStrategy'->>'signalKey'))
  WHERE strategy_family = 'usdjpy_strategy';

COMMENT ON INDEX paper_strategy_usdjpy_daily_signal_idx IS
  'Durable one-trade-per-UTC-day key for frozen usdjpy_strategy V6.';
