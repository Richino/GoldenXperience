-- Frozen AUDUSD Strong Consensus Structure V1. Pair-specific, H1, long-only.
-- Existing family behavior and risk settings remain unchanged.

ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN ('ema', 'breakout', 'momentum', 'meanrev', 'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy', 'audusd_strategy'));

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'audusd_strategy',
  'AUDUSD_STRONG_CONS_STRUCTURE_V1',
  'audusd-strategy-cfg-v1',
  '{
    "symbol": "AUD_USD",
    "timeframe": "H1",
    "direction": "LONG",
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "preRangeStartUtcHour": 6,
    "preRangeEndUtcHour": 10,
    "signalOriginUtcHour": 11,
    "minimumVoteSum": 4,
    "requiredStructure": "HH_HL",
    "stopAtr": 1.0,
    "rewardR": 2.0,
    "maxHoldBars": 3,
    "confidenceTagOnly": true,
    "bodyAtrMinimum": 0.50,
    "extremeClosePct": 0.25,
    "executionEnabled": true,
    "adaptiveParametersMutable": false
  }'::jsonb,
  'active'
)
ON CONFLICT(family, config_version) DO NOTHING;

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_audusd_long_only_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_audusd_long_only_check
  CHECK (strategy_family <> 'audusd_strategy' OR direction = 'long') NOT VALID;

ALTER TABLE paper_strategy_trades
  VALIDATE CONSTRAINT paper_strategy_trades_audusd_long_only_check;

-- The collector also checks (version, instrument, decision_time) inside its
-- advisory-locked transaction. This index makes the UTC-day signal identity a
-- durable invariant across restarts and future collector changes.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_audusd_signal_key_idx
  ON paper_strategy_trades((features->'audusdStrategy'->>'signalKey'))
  WHERE strategy_family = 'audusd_strategy';

COMMENT ON INDEX paper_strategy_audusd_signal_key_idx IS
  'Durable one-signal-per-UTC-day key for frozen audusd_strategy V1.';
