-- Finite plan lifecycle, locked approvals, and thesis-strength history.
--
-- 1. MISSED: a setup whose entry opportunity passed (price ran away without
--    the approved entry, or the approved entry window closed while blocked).
--    GX never chases; the plan ends with the reason.
-- 2. Approved plans are immutable at the database: while a plan is approved,
--    monitored, confirmed or executing, its levels, rules, risk, expiry and
--    mode cannot change. A user edit returns it to PENDING_APPROVAL as a new
--    version first (the only path that may change them).
-- 3. trade_plan_thesis_updates: how each new research snapshot changed the
--    evidence for an active plan (strengthening / weakening / ...). Research
--    never changes the plan itself.

ALTER TABLE trade_plans DROP CONSTRAINT IF EXISTS trade_plans_status_check;
ALTER TABLE trade_plans ADD CONSTRAINT trade_plans_status_check CHECK (status IN (
  'DRAFT','PENDING_APPROVAL','APPROVED','MONITORING','CONFIRMED','NOTIFIED',
  'EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED','EXECUTION_FAILED',
  'CLOSED','REJECTED','CANCELLED','INVALIDATED','EXPIRED','MISSED'));

INSERT INTO trade_plan_transitions(from_status, to_status) VALUES
  ('MONITORING','MISSED'), ('CONFIRMED','MISSED'), ('EXECUTION_PENDING','MISSED'), ('NOTIFIED','MISSED')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION trade_plans_check_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM trade_plan_transitions WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Illegal trade plan transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.instrument IS DISTINCT FROM OLD.instrument
     OR NEW.direction IS DISTINCT FROM OLD.direction THEN
    RAISE EXCEPTION 'Trade plan owner, pair and direction are immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- Approved plans are locked: only a return to PENDING_APPROVAL (a new version for re-approval) may change them.
  IF OLD.status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED','EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED')
     AND NEW.status IS DISTINCT FROM 'PENDING_APPROVAL'
     AND (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
          OR NEW.entry_zone_low IS DISTINCT FROM OLD.entry_zone_low OR NEW.entry_zone_high IS DISTINCT FROM OLD.entry_zone_high
          OR NEW.stop_loss IS DISTINCT FROM OLD.stop_loss OR NEW.take_profit IS DISTINCT FROM OLD.take_profit
          OR NEW.max_risk_percent IS DISTINCT FROM OLD.max_risk_percent OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
          OR NEW.monitoring_mode IS DISTINCT FROM OLD.monitoring_mode OR NEW.setup_type IS DISTINCT FROM OLD.setup_type) THEN
    RAISE EXCEPTION 'An approved trade plan cannot be changed; edit it into a new version for approval instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS trade_plan_thesis_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  research_id uuid NOT NULL,
  previous_research_id uuid,
  assessment text NOT NULL CHECK (assessment IN ('STRENGTHENING','WEAKENING','UNCHANGED','CONFLICTED','OUTDATED')),
  previous_alignment text,
  alignment text NOT NULL,
  -- Importance-weighted cited evidence for and against the plan's side, before and after.
  previous_weights jsonb,
  weights jsonb NOT NULL,
  -- What changed: new and dropped factors with their source ids, one-line explanation.
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, research_id)
);
CREATE INDEX IF NOT EXISTS trade_plan_thesis_updates_plan_idx ON trade_plan_thesis_updates(plan_id, created_at DESC);

-- The plans a research job built for each watcher, and why none when none.
ALTER TABLE research_job_watchers ADD COLUMN IF NOT EXISTS plans_reason text;
