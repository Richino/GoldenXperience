-- Frozen GBPUSD 30M Frequency V3. Keep the stable strategy family while
-- replacing V2 with the exact five-leg V3 configuration.

UPDATE strategy_configs
   SET status = 'retired'
 WHERE family = 'gbpusd_strategy'
   AND config_version <> 'gbpusd-frequency-v3'
   AND status = 'active';

INSERT INTO strategy_configs(
  family,
  strategy_version,
  config_version,
  configuration,
  status
) VALUES (
  'gbpusd_strategy',
  'v3',
  'gbpusd-frequency-v3',
  '{
    "symbol": "GBP_USD",
    "timeframe": "M30",
    "emaFastPeriod": 20,
    "emaSlowPeriod": 50,
    "atrPeriod": 14,
    "rangeStartUtc": "06:00",
    "origins": {
      "1030": {"hour": 10, "minute": 30, "expectedRangeBars": 9, "directions": ["LONG", "SHORT"]},
      "1100": {"hour": 11, "minute": 0, "expectedRangeBars": 10, "directions": ["LONG", "SHORT"]},
      "1130": {"hour": 11, "minute": 30, "expectedRangeBars": 11, "directions": ["LONG"]}
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
ON CONFLICT(family, config_version) DO UPDATE
SET status = EXCLUDED.status;

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_gbpusd_origin_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_gbpusd_origin_check
  CHECK (
    strategy_family <> 'gbpusd_strategy'
    OR COALESCE(features->'gbpusdStrategy'->>'originCode', '') IN ('1030', '1100', '1130')
  );

COMMENT ON INDEX paper_strategy_one_open_gbpusd_origin_idx IS
  'Allows independent GBPUSD 10:30, 11:00, and 11:30 logical legs without permitting duplicate open origin state.';
