-- Active blocked evaluations do not need duplicated feature JSON. Retired
-- strategy records remain untouched for historical auditability.
DELETE FROM evaluation_features ef
USING strategy_evaluations se, strategy_versions sv
WHERE ef.evaluation_id = se.id
  AND se.strategy_version_id = sv.id
  AND sv.name = 'deterministic-forex'
  AND sv.version = 'day-intraday-v1'
  AND se.status <> 'valid';

DELETE FROM shadow_outcome_labels sol
USING strategy_evaluations se, strategy_versions sv
WHERE sol.evaluation_id = se.id
  AND se.strategy_version_id = sv.id
  AND sv.name = 'deterministic-forex'
  AND sv.version = 'day-intraday-v1';
