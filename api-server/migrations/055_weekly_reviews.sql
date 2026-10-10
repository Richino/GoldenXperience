-- Home's weekly review, one row per user per week (Monday, New York): the
-- measured stats and findings plus the AI coach's summary. Past weeks are fed
-- back to the next summary so repeating mistakes are called out.
CREATE TABLE weekly_reviews (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  fingerprint text NOT NULL,
  stats jsonb NOT NULL,
  findings jsonb NOT NULL,
  summary jsonb,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_start)
);
