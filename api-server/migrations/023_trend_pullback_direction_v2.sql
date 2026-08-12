INSERT INTO strategy_versions(name, version, configuration)
VALUES (
  'deterministic-forex',
  'trend-pullback-liquidity-v2',
  '{"status":"active","mode":"automatic_paper_and_optional_practice","direction":"confirmed_H1_market_structure","pullback":"atr_normalized_counter_trend_with_H1_intact","sweep":"direction_consistent_reclaim","confirmation":"rejection_or_displacement","targetR":2,"newsLive":"fail_closed","newsHistorical":"not_evaluated","prices":"oanda_bid_ask","batchSize":100}'::jsonb
)
ON CONFLICT (name, version) DO UPDATE
SET configuration = strategy_versions.configuration || EXCLUDED.configuration;

UPDATE strategy_versions
SET configuration = configuration || '{"status":"retired","disposition":"preserved_read_only","retiredReason":"Direction was selected by the M15 sweep instead of confirmed H1 market structure."}'::jsonb
WHERE name = 'deterministic-forex'
  AND version = 'trend-pullback-liquidity-v1';

UPDATE paper_strategy_batches AS batch
SET status = 'resolving'
FROM strategy_versions AS version
WHERE batch.strategy_version_id = version.id
  AND batch.status = 'collecting'
  AND version.name = 'deterministic-forex'
  AND version.version = 'trend-pullback-liquidity-v1';
