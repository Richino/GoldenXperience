-- The active strategy is registered by runtime code as well as migrations.
-- Preserve lifecycle metadata when those writers add their observed settings.
UPDATE strategy_versions
SET configuration = configuration || '{"status":"active","mode":"automatic_paper_and_optional_practice"}'::jsonb
WHERE name = 'deterministic-forex'
  AND version = 'trend-pullback-liquidity-v1';

UPDATE strategy_versions
SET configuration = configuration || '{"status":"retired","disposition":"preserved_read_only"}'::jsonb
WHERE name = 'deterministic-forex'
  AND version IN ('macro-liquidity-v1', 'day-exploration-v1');
