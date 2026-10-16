-- Background market research: one durable job per research run. The browser
-- only starts a job and reads its state; the server worker submits it to
-- OpenAI (background mode), polls or receives the completion webhook,
-- validates, stores the market_research row, regenerates plans and notifies.
-- Add-only, except the notification kind list, which is widened.
CREATE TABLE IF NOT EXISTS research_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument text NOT NULL REFERENCES instruments(code),
  currencies text[] NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('MANUAL', 'SCHEDULED', 'RELEASE', 'STALE')),
  horizon text NOT NULL DEFAULT '2-5 trading days',
  model text NOT NULL,
  effort text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RESEARCHING', 'VALIDATING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  -- OpenAI's id for the background response; unique so a webhook maps to one job.
  openai_response_id text UNIQUE,
  -- The market_research row this job writes (fixed up front so a retry cannot write twice).
  research_id uuid NOT NULL UNIQUE,
  -- Inputs frozen when the job is submitted (verified calendar, technical read).
  calendar_snapshot jsonb,
  technical_summary jsonb,
  submit_attempts integer NOT NULL DEFAULT 0,
  poll_failures integer NOT NULL DEFAULT 0,
  -- Worker lease: one worker handles a job at a time; an expired lease is taken over after a restart.
  lease_owner text,
  lease_until timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  web_search_calls integer,
  sources_count integer,
  cost_usd numeric,
  validation_drops integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one running job per pair: a second Analyze joins it instead of paying again.
CREATE UNIQUE INDEX IF NOT EXISTS research_jobs_one_active_idx
  ON research_jobs(instrument) WHERE status IN ('QUEUED', 'RESEARCHING', 'VALIDATING');
CREATE INDEX IF NOT EXISTS research_jobs_due_idx
  ON research_jobs(next_check_at) WHERE status IN ('QUEUED', 'RESEARCHING', 'VALIDATING');
CREATE INDEX IF NOT EXISTS research_jobs_instrument_idx ON research_jobs(instrument, created_at DESC);

-- Who asked for a job: each is notified once, and gets plans built on the result.
CREATE TABLE IF NOT EXISTS research_job_watchers (
  job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  plans_result text,
  notified_at timestamptz,
  PRIMARY KEY (job_id, user_id)
);
CREATE INDEX IF NOT EXISTS research_job_watchers_pending_idx ON research_job_watchers(job_id) WHERE notified_at IS NULL;

ALTER TABLE market_research ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE market_research ADD COLUMN IF NOT EXISTS reasoning_tokens integer;
ALTER TABLE market_research ADD COLUMN IF NOT EXISTS duration_ms integer;

ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_kind_check
  CHECK (kind IN ('setup_ready', 'paper_opened', 'paper_closed', 'trade_update', 'system_issue', 'research_ready'));
