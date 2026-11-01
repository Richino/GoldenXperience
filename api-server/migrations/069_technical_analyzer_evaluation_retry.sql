-- Mutable operational state stays separate from immutable forecasts/outcomes.
CREATE TABLE gx_technical_evaluation_attempts (
  forecast_id text PRIMARY KEY REFERENCES gx_technical_forecasts(id),
  attempts integer NOT NULL DEFAULT 1,
  retry_after timestamptz NOT NULL,
  last_reason text NOT NULL
);
