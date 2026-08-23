-- News impact tagging: economic-calendar persistence + per-trade news context.
--
-- RESEARCH ONLY. Nothing here is read by strategy evaluation, the risk engine,
-- sizing, or execution. It exists to answer one question after the fact: does
-- strategy performance change around economic news, Momentum especially.
--
-- WHY AN EVENT TABLE IS REQUIRED. The ForexFactory feed publishes the CURRENT
-- WEEK only — nextweek/lastweek/today all 404 — and the app held it in a
-- 15-minute in-memory cache and never wrote it down. So no historical calendar
-- exists to tag past trades against. This table is the record that makes
-- backfill possible at all, and it starts accumulating from first ingest.

CREATE TABLE IF NOT EXISTS economic_calendar_events (
  -- Deterministic natural key from the feed: currency:title:timestamp. Re-
  -- ingesting the same week must update in place, never duplicate, which is
  -- what makes the backfill safe to run repeatedly.
  id text PRIMARY KEY,
  currency text NOT NULL,
  title text NOT NULL,
  -- Always stored as timestamptz, so every comparison happens in UTC and never
  -- against a local-time string.
  event_time timestamptz NOT NULL,
  -- Numeric scale shared with the calendar normalizer: high 3, medium 2,
  -- low 1, holiday 0.
  impact integer NOT NULL DEFAULT 0,
  region text,
  forecast text,
  previous text,
  actual text,
  source text NOT NULL DEFAULT 'forex_factory',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS economic_calendar_events_time_idx
  ON economic_calendar_events(event_time);

-- The lookup the tagger actually performs: relevant currency, near a time.
CREATE INDEX IF NOT EXISTS economic_calendar_events_currency_time_idx
  ON economic_calendar_events(currency, event_time);

-- Per-trade news context. Added as new columns beside the existing record;
-- nothing already stored is altered or overwritten. The pre-existing
-- `news_status` column is a different thing entirely — a coarse gate verdict
-- recorded at decision time — and is deliberately left untouched.
ALTER TABLE paper_strategy_trades
  ADD COLUMN IF NOT EXISTS news_impact_tag text,
  ADD COLUMN IF NOT EXISTS news_currency text,
  ADD COLUMN IF NOT EXISTS news_event_name text,
  ADD COLUMN IF NOT EXISTS news_event_time timestamptz,
  ADD COLUMN IF NOT EXISTS news_minutes_from_news numeric,
  ADD COLUMN IF NOT EXISTS news_impact_level integer,
  -- Every event that matched a window, not just the attributed one, so a later
  -- analyst can see a trade sat inside three overlapping releases.
  ADD COLUMN IF NOT EXISTS news_matched_event_ids text[],
  -- Provenance: when the tag was computed and under which windows. A tag
  -- produced by different thresholds is not comparable to one that was not.
  ADD COLUMN IF NOT EXISTS news_tagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS news_window_config jsonb;

ALTER TABLE paper_strategy_trades
  DROP CONSTRAINT IF EXISTS paper_strategy_trades_news_impact_tag_check;

ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_news_impact_tag_check
  CHECK (news_impact_tag IS NULL OR news_impact_tag IN ('NO_NEWS','NEAR_NEWS','HIGH_IMPACT_NEWS'));

CREATE INDEX IF NOT EXISTS paper_strategy_trades_news_tag_idx
  ON paper_strategy_trades(news_impact_tag);

-- The primary research cut: family x news tag, restricted to resolved trades.
CREATE INDEX IF NOT EXISTS paper_strategy_trades_family_news_idx
  ON paper_strategy_trades(strategy_family, news_impact_tag)
  WHERE result_r IS NOT NULL;
