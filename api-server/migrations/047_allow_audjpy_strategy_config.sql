-- AUDJPY Bull Consensus V1 is registered in the dedicated-pair runtime, but
-- migration 040 omitted its family from this immutable-config allowlist. That
-- caused every live collector cycle to fail while seeding the frozen config.
ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN (
    'ema', 'breakout', 'momentum', 'meanrev',
    'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy',
    'audusd_strategy', 'audjpy_strategy',
    'nzdusd_strategy', 'nzdusd_consensus_strategy',
    'usdcad_strategy', 'usdchf_strategy', 'eurjpy_strategy',
    'cadjpy_strategy', 'nzdjpy_strategy'
  ));
