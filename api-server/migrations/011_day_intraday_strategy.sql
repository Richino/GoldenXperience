-- The historical 48-hour strategy is preserved for audit, but is no longer
-- eligible to create Signals, forward evaluations, or new research evidence.
INSERT INTO strategy_versions (name, version, configuration)
VALUES (
  'deterministic-forex',
  'day-intraday-v1',
  '{"status":"active","timeframes":["M15","H1","H4"],"entryWindowEt":"03:00-12:00","forcedExitEt":"16:45","holding":"same_day","news":"not_evaluated","prices":"oanda_bid_ask"}'::jsonb
)
ON CONFLICT (name, version) DO UPDATE
SET configuration = EXCLUDED.configuration;

UPDATE strategy_versions
SET configuration = configuration || '{"status":"retired","disposition":"rejected","retiredReason":"Replaced by the day-intraday-v1 same-day strategy."}'::jsonb
WHERE name = 'deterministic-forex'
  AND version IN ('price-only-v1', 'v1');

UPDATE research_experiments experiment
SET decision = 'rejected',
    decision_note = COALESCE(experiment.decision_note || E'\n\n', '') || 'Retired/rejected with the 48-hour strategy; retained as historical evidence only.',
    decided_at = COALESCE(experiment.decided_at, now())
FROM strategy_versions version
WHERE experiment.strategy_version_id = version.id
  AND version.name = 'deterministic-forex'
  AND version.version IN ('price-only-v1', 'v1');

ALTER TABLE outcome_labels DROP CONSTRAINT IF EXISTS outcome_labels_outcome_check;
ALTER TABLE outcome_labels
  ADD CONSTRAINT outcome_labels_outcome_check
  CHECK (outcome IN ('target_first', 'stop_first', 'forced_close', 'unresolved', 'ambiguous'));

ALTER TABLE shadow_outcome_labels DROP CONSTRAINT IF EXISTS shadow_outcome_labels_outcome_check;
ALTER TABLE shadow_outcome_labels
  ADD CONSTRAINT shadow_outcome_labels_outcome_check
  CHECK (outcome IN ('target_first', 'stop_first', 'forced_close', 'unresolved', 'ambiguous'));
