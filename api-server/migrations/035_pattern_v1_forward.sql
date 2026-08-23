-- Pattern V1 forward paper engine.
--
-- A SECOND, INDEPENDENT binary strategy running alongside binary-baseline-v1.
-- Paper/research prediction tracking only: no order is placed, and the existing
-- baseline engine, its thresholds, its timing and the adaptive selector are all
-- left exactly as they are.
--
-- Pattern V1 rows live in binary_predictions because that table already carries
-- clean per-model attribution: migration 029 scoped the one-active index by
-- model_name, so baseline and Pattern V1 can hold an active 10-minute
-- prediction on the same symbol at the same time without either blocking the
-- other. That coexistence is the point — a disagreement between the two is
-- evidence, not a conflict to resolve.

INSERT INTO binary_models (name, version, score_kind, configuration)
VALUES (
  'binary-pattern-v1',
  '1.0.0',
  'heuristic_score',
  '{"kind":"frozen_pattern","experimentId":"pattern-v1-sealed-holdout-v1","source":"pattern-v1-forward","configHash":"0e3cba650a3b62fda62db80d4b4af4bc37536851f233cadd4d995aca990f05cd","horizonSeconds":600,"direction":"up","logic":"UP AND ((rsiSeverity==extreme AND adxBucket==gt30) OR (rsiSeverity==medium AND adxBucket==b20_25))","bb":{"period":20,"k":2.0,"stdev":"population"},"rsi":{"method":"Wilder","period":14,"os":30,"ob":70},"adx":{"method":"Wilder","period":14,"buckets":{"le20":"adx <= 20","b20_25":"20 < adx <= 25","b25_30":"25 < adx <= 30","gt30":"adx > 30"}},"note":"FROZEN for forward testing. Historical TRAIN+DEV 61.75%, SEALED HOLDOUT 55.96% are RESEARCH results and are not forward performance. The forward counter starts at zero."}'::jsonb
)
ON CONFLICT (name, version) DO NOTHING;

-- The signal bar this prediction came from, as the bar's CLOSE instant. This is
-- the natural dedup key: Pattern V1 is evaluated on every closed M1 candle, so
-- without it a restart, an overlapping cycle or a retry could open the same
-- prediction twice.
ALTER TABLE binary_predictions
  ADD COLUMN IF NOT EXISTS signal_candle_time timestamptz,
  -- Which experiment produced the row, kept beside model_name so a future
  -- second Pattern V1 cohort is distinguishable from this one.
  ADD COLUMN IF NOT EXISTS strategy_source text,
  -- The frozen research config the row was generated under. Makes "was this
  -- produced by the same configuration the holdout used" answerable by query.
  ADD COLUMN IF NOT EXISTS pattern_config_hash text;

COMMENT ON COLUMN binary_predictions.signal_candle_time IS
  'Close instant of the M1 bar that produced the signal. Dedup key for candle-driven strategies; NULL for the baseline engine, which is quote-driven rather than bar-driven.';

-- Duplicate protection in the DATABASE, not in memory: restarting the server
-- must not be able to reopen a prediction for a signal bar already recorded.
-- Partial, so baseline rows (signal_candle_time NULL) are untouched by it.
CREATE UNIQUE INDEX IF NOT EXISTS binary_predictions_signal_candle_idx
  ON binary_predictions (model_name, instrument, signal_candle_time, duration_seconds)
  WHERE signal_candle_time IS NOT NULL;

-- The per-strategy cut every Pattern V1 statistic is computed over. Statistics
-- must never silently combine the two strategies into one win rate.
CREATE INDEX IF NOT EXISTS binary_predictions_model_created_idx
  ON binary_predictions (model_name, created_at DESC);

-- Extend the immutability guard to cover the new provenance columns. Once a
-- Pattern V1 row exists, the bar it came from and the config it ran under
-- cannot be rewritten, which is what makes the forward record auditable.
CREATE OR REPLACE FUNCTION binary_predictions_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.direction <> OLD.direction
     OR NEW.entry_price <> OLD.entry_price
     OR NEW.start_at <> OLD.start_at
     OR NEW.intended_expiration <> OLD.intended_expiration
     OR NEW.duration_seconds <> OLD.duration_seconds
     OR NEW.created_at <> OLD.created_at
     OR NEW.instrument <> OLD.instrument THEN
    RAISE EXCEPTION 'binary_predictions immutable fields cannot be modified (id=%)', OLD.id;
  END IF;
  IF OLD.signal_candle_time IS NOT NULL
     AND NEW.signal_candle_time IS DISTINCT FROM OLD.signal_candle_time THEN
    RAISE EXCEPTION 'binary_predictions signal_candle_time is immutable (id=%)', OLD.id;
  END IF;
  IF OLD.pattern_config_hash IS NOT NULL
     AND NEW.pattern_config_hash IS DISTINCT FROM OLD.pattern_config_hash THEN
    RAISE EXCEPTION 'binary_predictions pattern_config_hash is immutable (id=%)', OLD.id;
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'binary_predictions result is immutable once decided (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No existing row is modified by this migration. Baseline predictions keep
-- signal_candle_time / strategy_source / pattern_config_hash NULL, which is
-- exactly what separates the two cohorts by query.
