-- 047 shipped without the already-active EUR/AUD frozen strategy family.
-- Rebuild the immutable config allowlist so existing production databases
-- accept both the AUD/JPY and EUR/AUD dedicated runtimes.
ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN (
    'ema', 'breakout', 'momentum', 'meanrev',
    'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy',
    'audusd_strategy', 'audjpy_strategy', 'euraud_strategy',
    'nzdusd_strategy', 'nzdusd_consensus_strategy',
    'usdcad_strategy', 'usdchf_strategy', 'eurjpy_strategy',
    'cadjpy_strategy', 'nzdjpy_strategy'
  ));
