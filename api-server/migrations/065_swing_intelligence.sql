-- Additive, analysis-only state. No references into order/execution queues.
CREATE TABLE IF NOT EXISTS swing_assessments (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_key text NOT NULL, instrument text NOT NULL REFERENCES instruments(code),
  snapshot jsonb NOT NULL, fundamental_report jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS swing_assessments_latest ON swing_assessments(user_id,account_key,instrument,created_at DESC);
CREATE TABLE IF NOT EXISTS swing_monitors (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_key text NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code), active boolean NOT NULL DEFAULT false,
  style text NOT NULL DEFAULT 'BALANCED' CHECK(style IN ('AGGRESSIVE','BALANCED','CONSERVATIVE')),
  market jsonb, market_updated_at timestamptz, assessment_id uuid REFERENCES swing_assessments(id),
  unavailable_zones jsonb NOT NULL DEFAULT '[]', schedule_state jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,account_key,instrument)
);
CREATE INDEX IF NOT EXISTS swing_monitors_active ON swing_monitors(account_key,instrument) WHERE active;
CREATE TABLE IF NOT EXISTS swing_research_jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_key text NOT NULL,
  instrument text NOT NULL REFERENCES instruments(code), kind text NOT NULL CHECK(kind IN ('DAILY','MATERIAL_NEWS','MANUAL','HOURLY_CHECK')),
  status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','BUDGET_BLOCKED')),
  dedupe_key text NOT NULL, reserved_usd numeric NOT NULL CHECK(reserved_usd>=0), attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz, error text,
  UNIQUE(user_id,account_key,instrument,dedupe_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS swing_one_active_job ON swing_research_jobs(user_id,account_key,instrument) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX IF NOT EXISTS swing_jobs_due ON swing_research_jobs(account_key,next_attempt_at) WHERE status='QUEUED';
CREATE TABLE IF NOT EXISTS swing_ai_usage (
  id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES swing_research_jobs(id), user_id uuid NOT NULL REFERENCES users(id),
  account_key text NOT NULL, instrument text NOT NULL, stage text NOT NULL, model text NOT NULL,
  input_tokens integer, output_tokens integer, searches integer NOT NULL DEFAULT 0, latency_ms integer NOT NULL,
  cost_usd numeric, success boolean NOT NULL, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS swing_ai_usage_budget ON swing_ai_usage(account_key,created_at);
CREATE TABLE IF NOT EXISTS swing_fundamental_evidence (
  assessment_id uuid NOT NULL REFERENCES swing_assessments(id) ON DELETE CASCADE, factor_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  evidence jsonb NOT NULL, sources jsonb NOT NULL, observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(assessment_id,factor_id)
);
CREATE TABLE IF NOT EXISTS swing_technical_snapshots (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  fingerprint text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,account_key,instrument,fingerprint)
);
CREATE INDEX IF NOT EXISTS swing_technical_latest ON swing_technical_snapshots(user_id,account_key,instrument,created_at DESC);
CREATE TABLE IF NOT EXISTS swing_zones (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  generation text NOT NULL, classification text NOT NULL, status text NOT NULL
    CHECK(status IN ('WATCHING','TOUCHED','EVALUATING','ELIGIBLE','REJECTED','EXPIRED')),
  revision integer NOT NULL DEFAULT 0, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(user_id,account_key,instrument,generation,classification)
);
CREATE INDEX IF NOT EXISTS swing_zones_active ON swing_zones(user_id,account_key,instrument,updated_at DESC) WHERE status<>'EXPIRED';
CREATE TABLE IF NOT EXISTS swing_zone_events (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  zone_id uuid REFERENCES swing_zones(id), dedupe_key text NOT NULL, kind text NOT NULL, detail text NOT NULL,
  data jsonb NOT NULL, at timestamptz NOT NULL, UNIQUE(user_id,account_key,instrument,dedupe_key)
);
CREATE INDEX IF NOT EXISTS swing_events_latest ON swing_zone_events(user_id,account_key,instrument,at DESC);
CREATE TABLE IF NOT EXISTS swing_movement_aggregates (
  user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  bucket timestamptz NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,account_key,instrument,bucket)
);
CREATE TABLE IF NOT EXISTS swing_scenarios (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  zone_id uuid NOT NULL REFERENCES swing_zones(id), side text NOT NULL CHECK(side IN ('BUY','SELL')),
  signature text NOT NULL, snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(user_id,account_key,zone_id,side)
);
CREATE TABLE IF NOT EXISTS swing_expectancy (
  user_id uuid NOT NULL REFERENCES users(id), account_key text NOT NULL, instrument text NOT NULL,
  strategy_version text NOT NULL, style text NOT NULL, side text NOT NULL CHECK(side IN ('BUY','SELL')),
  sample_size integer NOT NULL CHECK(sample_size>0), expectancy_r numeric NOT NULL,
  win_rate numeric CHECK(win_rate BETWEEN 0 AND 1), source text NOT NULL, validated_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,account_key,instrument,strategy_version,style,side)
);
-- GX authenticates via its own sessions/users, not auth.uid(). Private server
-- repositories enforce user_id+account_key on every read/write. No browser grant.
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['swing_assessments','swing_monitors','swing_research_jobs','swing_ai_usage',
    'swing_fundamental_evidence','swing_technical_snapshots','swing_zones','swing_zone_events',
    'swing_movement_aggregates','swing_scenarios','swing_expectancy'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,r); END IF;
    END LOOP;
  END LOOP;
END $$;
