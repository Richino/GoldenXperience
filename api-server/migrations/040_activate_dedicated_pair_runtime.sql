-- Activate the ten frozen pair-specific strategies for paper/OANDA-practice
-- runtime and retire the legacy four-family execution configs. This migration
-- does not enable practice-order policy, submit an order, or select OANDA live.

INSERT INTO instruments(code, display_name, price_precision)
VALUES
  ('CAD_JPY', 'CAD/JPY', 3),
  ('NZD_JPY', 'NZD/JPY', 3)
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name,
    price_precision = EXCLUDED.price_precision;

ALTER TABLE strategy_configs
  DROP CONSTRAINT IF EXISTS strategy_configs_family_check;

ALTER TABLE strategy_configs
  ADD CONSTRAINT strategy_configs_family_check
  CHECK (family IN (
    'ema', 'breakout', 'momentum', 'meanrev',
    'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy',
    'audusd_strategy', 'nzdusd_strategy', 'nzdusd_consensus_strategy',
    'usdcad_strategy', 'usdchf_strategy', 'eurjpy_strategy',
    'cadjpy_strategy', 'nzdjpy_strategy'
  ));

-- Status is the only mutable field on strategy_configs. Preserve every frozen
-- configuration row and all historical evidence while preventing new legacy
-- family execution. The old NZDUSD pre-range module is also not the selected
-- frozen NZDUSD contract for this runtime.
UPDATE strategy_configs
   SET status = 'retired'
 WHERE family IN ('ema', 'breakout', 'momentum', 'meanrev', 'nzdusd_strategy')
   AND status <> 'retired';

UPDATE strategy_configs
   SET status = 'active'
 WHERE family IN (
   'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy',
   'audusd_strategy', 'nzdusd_consensus_strategy', 'usdcad_strategy',
   'usdchf_strategy', 'eurjpy_strategy', 'cadjpy_strategy', 'nzdjpy_strategy'
 );

-- Do not let previously queued legacy-family/liquidity intents turn into
-- immediate broker orders when this runtime is deployed. Only a fresh signal
-- from one of the ten enabled pair strategies may create a sendable intent.
UPDATE practice_order_intents AS intent
   SET status = 'disabled',
       failure_reason = COALESCE(intent.failure_reason, 'Disabled at dedicated pair runtime activation.'),
       updated_at = now()
  FROM paper_strategy_trades AS trade
 WHERE trade.id = intent.paper_trade_id
   AND intent.status = 'pending'
   AND (trade.strategy_family IS NULL OR trade.strategy_family <> ALL (ARRAY[
     'eurusd_strategy', 'usdjpy_strategy', 'gbpusd_strategy',
     'audusd_strategy', 'nzdusd_consensus_strategy', 'usdcad_strategy',
     'usdchf_strategy', 'eurjpy_strategy', 'cadjpy_strategy', 'nzdjpy_strategy'
   ]::text[]));

ALTER TABLE paper_strategy_trades
  ADD COLUMN IF NOT EXISTS signal_price numeric,
  ADD COLUMN IF NOT EXISTS actual_fill_price numeric,
  ADD COLUMN IF NOT EXISTS max_hold_bars integer,
  ADD COLUMN IF NOT EXISTS bars_held integer;

COMMENT ON COLUMN paper_strategy_trades.signal_price IS
  'Frozen signal price, kept distinct from executable entry and any broker fill.';
COMMENT ON COLUMN paper_strategy_trades.actual_fill_price IS
  'Confirmed OANDA-practice fill price when practice execution is separately enabled.';
COMMENT ON COLUMN paper_strategy_trades.max_hold_bars IS
  'Frozen strategy-specific maximum number of completed holding bars.';
COMMENT ON COLUMN paper_strategy_trades.bars_held IS
  'Completed strategy bars held when the trade resolved.';

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_gbpusd_origin_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_gbpusd_origin_check
  CHECK (
    strategy_family <> 'gbpusd_strategy'
    OR COALESCE(features->'gbpusdStrategy'->>'originCode', '') IN ('1030', '1100', '1130')
  ) NOT VALID;

ALTER TABLE paper_strategy_trades
  VALIDATE CONSTRAINT paper_strategy_trades_gbpusd_origin_check;

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_audusd_long_only_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_audusd_long_only_check
  CHECK (strategy_family <> 'audusd_strategy' OR direction = 'long') NOT VALID;

ALTER TABLE paper_strategy_trades
  VALIDATE CONSTRAINT paper_strategy_trades_audusd_long_only_check;

DROP INDEX IF EXISTS paper_strategy_one_open_pair_idx;

-- Different instruments can be open together. A single non-GBPUSD instrument
-- remains protected from duplicate concurrent positions; this intentionally
-- preserves the existing portfolio/risk boundary.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_one_open_non_gbpusd_idx
  ON paper_strategy_trades(instrument)
  WHERE status = 'open' AND strategy_family IS DISTINCT FROM 'gbpusd_strategy';

-- Frequency V3 has three independent logical origins on GBPUSD.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_one_open_gbpusd_origin_idx
  ON paper_strategy_trades(
    instrument,
    (features->'gbpusdStrategy'->>'originCode')
  )
  WHERE status = 'open' AND strategy_family = 'gbpusd_strategy';

-- Durable duplicate protection survives process restarts and scheduler retries.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_eurusd_signal_key_idx
  ON paper_strategy_trades((features->'eurusdStrategy'->>'signalKey'))
  WHERE strategy_family = 'eurusd_strategy';

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_usdjpy_daily_signal_idx
  ON paper_strategy_trades((features->'usdjpyStrategy'->>'signalKey'))
  WHERE strategy_family = 'usdjpy_strategy';

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_gbpusd_signal_key_idx
  ON paper_strategy_trades((features->'gbpusdStrategy'->>'signalKey'))
  WHERE strategy_family = 'gbpusd_strategy';

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_audusd_signal_key_idx
  ON paper_strategy_trades((features->'audusdStrategy'->>'signalKey'))
  WHERE strategy_family = 'audusd_strategy';

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_frozen_h1_signal_key_idx
  ON paper_strategy_trades((features->'frozenPairStrategy'->>'signalKey'))
  WHERE strategy_family IN (
    'nzdusd_consensus_strategy', 'usdcad_strategy', 'usdchf_strategy',
    'eurjpy_strategy', 'cadjpy_strategy', 'nzdjpy_strategy'
  );

COMMENT ON INDEX paper_strategy_one_open_non_gbpusd_idx IS
  'One open position per instrument; distinct instruments remain independent.';
COMMENT ON INDEX paper_strategy_one_open_gbpusd_origin_idx IS
  'One open GBPUSD Frequency V3 position per frozen 10:30, 11:00, or 11:30 origin.';
COMMENT ON INDEX paper_strategy_frozen_h1_signal_key_idx IS
  'Durable per-pair signal identity for the six frozen H1 pair modules.';
