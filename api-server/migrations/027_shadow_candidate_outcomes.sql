-- Shadow outcome resolution for suppressed/blocked valid candidates.
--
-- Every valid multi-strategy candidate that was NOT executed (another strategy
-- won the conflict, the adaptive engine suppressed it, or an open position
-- blocked the instrument) is preserved in paper_strategy_evaluations. This table
-- holds the HYPOTHETICAL outcome that candidate would have had, resolved with
-- the same labelOutcome machinery the real trades use — but never sent to OANDA,
-- never a paper position, and never counted in risk/exposure.
--
-- One row per evaluation (the candidate). It links back to the evaluation, which
-- already carries strategy family/version, config version, regime, decision
-- time, entry, stop, target, conditions and features — so a shadow result is
-- fully attributable and comparable to the executed results. Additive: nothing
-- here touches existing trades, batches, or the binary system.

CREATE TABLE IF NOT EXISTS shadow_candidate_outcomes (
  evaluation_id uuid PRIMARY KEY REFERENCES paper_strategy_evaluations(id) ON DELETE CASCADE,
  outcome text NOT NULL
    CHECK (outcome IN ('target_first', 'stop_first', 'forced_close', 'timeout', 'ambiguous')),
  result_r numeric,
  max_favorable_r numeric,
  max_adverse_r numeric,
  exit numeric,
  -- The actual (historical) time the hypothetical outcome occurred, or the
  -- horizon time for a timeout. Null only for an ambiguous within-bar result.
  resolved_at timestamptz,
  horizon_ends_at timestamptz NOT NULL,
  exit_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_candidate_outcomes_resolved_idx
  ON shadow_candidate_outcomes (resolved_at);
