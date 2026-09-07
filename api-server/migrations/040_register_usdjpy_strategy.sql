-- Frozen USDJPY Body Extreme V1. This migration registers and activates only
-- the pair-specific strategy; the existing adaptive and EURUSD rules are not changed.

ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN ('ema', 'breakout', 'momentum', 'meanrev', 'eurusd_strategy', 'usdjpy_strategy'));

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'usdjpy_strategy',
  'v1',
  'usdjpy-strategy-cfg-v1',
  '{
    "symbol": "USD_JPY",
    "timeframe": "H1",
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "preRangeStartUtcHour": 6,
    "preRangeEndUtcHour": 10,
    "signalOriginUtcHour": 11,
    "minimumBodyAtr": 0.50,
    "extremeClosePct": 0.25,
    "stopAtr": 1.0,
    "rewardR": 2.0,
    "maxHoldBars": 3,
    "setup": "USDJPY_BODY_EXTREME",
    "executionEnabled": true,
    "adaptiveParametersMutable": false
  }'::jsonb,
  'active'
)
ON CONFLICT(family, config_version) DO NOTHING;

ALTER TABLE paper_strategy_trades
  ADD COLUMN IF NOT EXISTS signal_price numeric,
  ADD COLUMN IF NOT EXISTS actual_fill_price numeric,
  ADD COLUMN IF NOT EXISTS max_hold_bars integer,
  ADD COLUMN IF NOT EXISTS bars_held integer;

COMMENT ON COLUMN paper_strategy_trades.signal_price IS
  'Frozen signal-candle close, distinct from the executable entry and broker fill.';
COMMENT ON COLUMN paper_strategy_trades.actual_fill_price IS
  'Actual OANDA market fill when practice execution reports one.';
COMMENT ON COLUMN paper_strategy_trades.max_hold_bars IS
  'Strategy-specific completed-bar holding limit; USDJPY Body Extreme V1 uses 3 H1 bars.';
COMMENT ON COLUMN paper_strategy_trades.bars_held IS
  'Completed strategy bars held when the trade resolved.';
