CREATE TABLE gx_technical_forecasts (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  account_key text NOT NULL,
  instrument text NOT NULL,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  horizon smallint NOT NULL CHECK (horizon BETWEEN 1 AND 5),
  eligible boolean NOT NULL,
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL,
  forecast jsonb NOT NULL,
  UNIQUE (user_id, account_key, fingerprint, horizon)
);
CREATE INDEX gx_technical_forecasts_due ON gx_technical_forecasts (expires_at);
CREATE INDEX gx_technical_forecasts_owner ON gx_technical_forecasts (user_id, account_key, created_at DESC);
CREATE TABLE gx_technical_outcomes (
  forecast_id text PRIMARY KEY REFERENCES gx_technical_forecasts(id),
  outcome jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
-- Original forecasts are append-only; evaluation is stored in a separate table.
CREATE FUNCTION gx_technical_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GX technical forecasts and outcomes are immutable'; END;
$$;
CREATE TRIGGER gx_technical_forecasts_immutable BEFORE UPDATE OR DELETE ON gx_technical_forecasts
FOR EACH ROW EXECUTE FUNCTION gx_technical_immutable();
CREATE TRIGGER gx_technical_outcomes_immutable BEFORE UPDATE OR DELETE ON gx_technical_outcomes
FOR EACH ROW EXECUTE FUNCTION gx_technical_immutable();
