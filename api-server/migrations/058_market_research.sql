-- Market intelligence research: one row per research run (GPT + web search),
-- kept as the cache, the citation record and the cost ledger. Add-only.
CREATE TABLE IF NOT EXISTS market_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument text NOT NULL REFERENCES instruments(code),
  currencies text[] NOT NULL,
  -- Why it ran: the user pressed Analyze, the schedule, a new release, or stale research.
  trigger text NOT NULL CHECK (trigger IN ('MANUAL', 'SCHEDULED', 'RELEASE', 'STALE')),
  status text NOT NULL CHECK (status IN ('COMPLETE', 'FAILED', 'BUDGET_BLOCKED')),
  model text,
  -- Validated report: only citations the web search actually returned survive.
  report jsonb,
  -- Every URL the search returned (title, url), for audit.
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Verified calendar data given to the model (never model-generated).
  calendar_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Compact technical read given to the model (from the deterministic engine).
  technical_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Items the validator dropped (uncited, unknown URL, bad shape), for audit.
  dropped jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens integer,
  output_tokens integer,
  web_search_calls integer,
  cost_usd numeric,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS market_research_instrument_idx ON market_research(instrument, created_at DESC);
CREATE INDEX IF NOT EXISTS market_research_created_idx ON market_research(created_at);
