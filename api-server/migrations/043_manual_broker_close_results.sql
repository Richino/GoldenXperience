-- Manual OANDA closes must keep the broker's realised cash P/L alongside the
-- executable result R. The journal and Home activity feed use this value rather
-- than inventing cash P/L from a nominal risk calculation.
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS paper_pl numeric;
