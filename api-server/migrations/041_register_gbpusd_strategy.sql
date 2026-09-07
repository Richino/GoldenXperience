-- Frozen GBPUSD 30M Dual-Origin V2. This registers only GBP_USD and replaces
-- the incompatible one-open-per-instrument index with a two-origin invariant.
-- All other strategies retain one open trade per instrument.

ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN ('ema', 'breakout', 'momentum', 'meanrev', 'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy'));

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'gbpusd_strategy',
  'v2',
  'gbpusd-strategy-cfg-v2',
  '{
    "symbol": "GBP_USD",
    "timeframe": "M30",
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "rangeStartUtc": "06:00",
    "origins": {
      "1030": {"hour": 10, "minute": 30, "expectedRangeBars": 9},
      "1100": {"hour": 11, "minute": 0, "expectedRangeBars": 10}
    },
    "stopAtr": 1.0,
    "rewardR": 2.0,
    "maxHoldBars": 6,
    "penetrationAtr": 0.25,
    "extremeClosePct": 0.25,
    "executionEnabled": true,
    "adaptiveParametersMutable": false
  }'::jsonb,
  'active'
)
ON CONFLICT(family, config_version) DO NOTHING;

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_gbpusd_origin_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_gbpusd_origin_check
  CHECK (
    strategy_family <> 'gbpusd_strategy'
    OR COALESCE(features->'gbpusdStrategy'->>'originCode', '') IN ('1030', '1100')
  );

DROP INDEX IF EXISTS paper_strategy_one_open_pair_idx;

-- Existing families remain limited to one open trade per instrument.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_one_open_non_gbpusd_idx
  ON paper_strategy_trades(instrument)
  WHERE status = 'open' AND strategy_family IS DISTINCT FROM 'gbpusd_strategy';

-- GBPUSD may hold one 10:30 leg and one 11:00 leg at the same time. The
-- collector's advisory transaction lock also prevents a non-GBP strategy from
-- racing one of these legs onto the same instrument.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_one_open_gbpusd_origin_idx
  ON paper_strategy_trades(
    instrument,
    (features->'gbpusdStrategy'->>'originCode')
  )
  WHERE status = 'open' AND strategy_family = 'gbpusd_strategy';

-- Restart-safe one-signal-per-UTC-day/origin enforcement.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_gbpusd_signal_key_idx
  ON paper_strategy_trades((features->'gbpusdStrategy'->>'signalKey'))
  WHERE strategy_family = 'gbpusd_strategy';

COMMENT ON INDEX paper_strategy_one_open_gbpusd_origin_idx IS
  'Allows independent GBPUSD 10:30 and 11:00 logical legs without permitting duplicate open origin state.';
COMMENT ON INDEX paper_strategy_gbpusd_signal_key_idx IS
  'Durable one-signal-per-UTC-day/origin key for gbpusd_strategy.';
