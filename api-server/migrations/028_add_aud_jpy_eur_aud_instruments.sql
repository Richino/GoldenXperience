-- AUD/JPY and EUR/AUD were added to the traded instrument set in code
-- (MAJOR_INSTRUMENTS) but the `instruments` reference table — which
-- paper_strategy_evaluations, binary_watch_snapshots and others foreign-key
-- against — was never updated to match. AUD_JPY in particular was missing, so
-- every collection cycle that evaluated it threw a foreign-key violation and
-- aborted before it could submit practice orders, stranding order intents in
-- `pending` and leaving the broker account (and the dashboard balance) unmoved.
--
-- Idempotent so it is safe on databases where the row was already patched in by
-- hand.
INSERT INTO instruments(code, display_name, price_precision)
VALUES
  ('AUD_JPY', 'AUD/JPY', 3),
  ('EUR_AUD', 'EUR/AUD', 5)
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name,
    price_precision = EXCLUDED.price_precision;
