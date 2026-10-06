-- News prediction journal. One row per scheduled release: the beat/miss call
-- is frozen before the release (never rewritten), then scored once the actual
-- is known. The per-signal votes are kept so the picker can learn which signal
-- has the best real record, overall and per series.
CREATE TABLE IF NOT EXISTS news_predictions (
  event_key text PRIMARY KEY,
  series_key text NOT NULL,
  title text NOT NULL,
  currency text NOT NULL,
  impact integer,
  event_time timestamptz NOT NULL,
  forecast text,
  previous text,
  -- {"previous": 1, "momentum": -1, "streak": 0, "related": 1}: +1 beat, -1 miss.
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Signal used for the call, e.g. "previous" or "momentum:inverse".
  chosen_signal text,
  call text CHECK (call IN ('beat', 'miss')),
  currency_call text CHECK (currency_call IN ('up', 'down')),
  predicted_at timestamptz NOT NULL DEFAULT now(),
  -- 'live' = called before release; 'backfill' = history seeded for learning.
  source text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill')),
  actual text,
  outcome text CHECK (outcome IN ('beat', 'miss', 'inline')),
  correct boolean,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS news_predictions_series_idx ON news_predictions (series_key, event_time);
CREATE INDEX IF NOT EXISTS news_predictions_unresolved_idx ON news_predictions (event_time) WHERE outcome IS NULL;
