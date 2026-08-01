-- Keep detailed feature JSON only for actual valid candidates. Blocked
-- evaluations retain their compact conditions JSON for the funnel, but no
-- longer carry a second copy of the full feature snapshot.
DELETE FROM evaluation_features features
USING strategy_evaluations evaluations, strategy_versions versions
WHERE features.evaluation_id = evaluations.id
  AND evaluations.strategy_version_id = versions.id
  AND versions.name = 'deterministic-forex'
  AND versions.version = 'day-intraday-v1'
  AND evaluations.source_kind = 'historical'
  AND evaluations.status <> 'valid';

-- Shadow outcomes are diagnostic-only and are disabled for the active strategy.
-- Retired strategy records remain untouched and auditable.
DELETE FROM shadow_outcome_labels shadows
USING strategy_evaluations evaluations, strategy_versions versions
WHERE shadows.evaluation_id = evaluations.id
  AND evaluations.strategy_version_id = versions.id
  AND versions.name = 'deterministic-forex'
  AND versions.version = 'day-intraday-v1';
