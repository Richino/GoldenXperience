CREATE INDEX IF NOT EXISTS strategy_evaluations_diagnostics_idx
  ON strategy_evaluations (strategy_version_id, source_kind, instrument, decision_time DESC)
  INCLUDE (status, direction, entry, stop, target, risk_reward, spread_pips);

CREATE INDEX IF NOT EXISTS strategy_evaluations_conditions_gin_idx
  ON strategy_evaluations USING gin (conditions jsonb_path_ops);
