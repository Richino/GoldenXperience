-- The replacement trend-pullback strategy owns all future collections. File
-- the old macro batch as soon as its already-assigned trades are all closed so
-- it cannot be presented as the current collection.
UPDATE paper_strategy_batches AS batch
SET status = 'resolving'
FROM strategy_versions AS version
WHERE batch.strategy_version_id = version.id
  AND batch.status = 'collecting'
  AND version.name = 'deterministic-forex'
  AND version.version = 'macro-liquidity-v1'
  AND COALESCE(version.configuration->>'status', '') = 'retired'
  AND NOT EXISTS (
    SELECT 1
    FROM paper_strategy_trades AS trade
    WHERE trade.batch_id = batch.id
      AND trade.status = 'open'
  );
