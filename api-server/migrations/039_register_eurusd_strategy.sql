-- Register EURUSD London Breakout V1 without enabling evaluation or execution.
-- Code-side activation remains deliberately empty in ENABLED_PAIR_STRATEGY_IDS.

ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN ('ema', 'breakout', 'momentum', 'meanrev', 'eurusd_strategy'));

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'eurusd_strategy',
  'v1',
  'eurusd-strategy-cfg-v1',
  '{
    "symbol": "EUR_USD",
    "timeframe": "H1",
    "asiaStartUtcHour": 0,
    "asiaEndUtcHour": 6,
    "londonStartUtcHour": 6,
    "londonEndUtcHour": 11,
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "minimumBodyAtr": 0.35,
    "stopAtr": 1.0,
    "rewardR": 2.0,
    "setup": "A_LONDON_BO",
    "executionEnabled": false,
    "adaptiveParametersMutable": false
  }'::jsonb,
  'shadow'
)
ON CONFLICT(family, config_version) DO NOTHING;
