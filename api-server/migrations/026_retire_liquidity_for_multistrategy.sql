-- Retire the single liquidity strategy in favour of the multi-strategy +
-- adaptive engine, using the same preserved-read-only pattern as every prior
-- retirement (011, 020, 021, 023).
--
-- What actually stops the liquidity strategy from trading is the runtime switch
-- (MULTISTRATEGY_ENABLED, default on) — the collector simply runs the four new
-- strategies instead. This migration is the bookkeeping that matches that
-- switch: it marks the version retired and moves its still-collecting batch to
-- resolving so its open trades finish normally and it files itself.
--
-- Nothing here deletes, relabels, or rewrites a single historical trade, batch,
-- journal entry, or strategy version. The liquidity code remains in the tree for
-- historical reproduction and research. Rollback is setting MULTISTRATEGY_ENABLED
-- to false; the preserved code resumes and a fresh liquidity batch is created on
-- the next cycle. The binary prediction system is untouched.

UPDATE strategy_versions
SET configuration = configuration || '{"status":"retired","disposition":"preserved_read_only","retiredReason":"Replaced by the four-strategy (EMA/Breakout/Momentum/Mean Reversion) architecture with the cold-start adaptive engine."}'::jsonb
WHERE name = 'deterministic-forex'
  AND version = 'trend-pullback-liquidity-v2';

-- File the liquidity strategy's collecting batch: it becomes resolving now and
-- completes on its own once every already-open liquidity trade closes (handled
-- by completeReadyBatches in the running collector). Historical liquidity
-- batches that are already complete are left exactly as they are.
UPDATE paper_strategy_batches AS batch
SET status = 'resolving'
FROM strategy_versions AS version
WHERE batch.strategy_version_id = version.id
  AND batch.status = 'collecting'
  AND version.name = 'deterministic-forex'
  AND version.version = 'trend-pullback-liquidity-v2';
