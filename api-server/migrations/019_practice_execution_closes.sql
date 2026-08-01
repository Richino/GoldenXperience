ALTER TABLE practice_order_intents
  ADD COLUMN IF NOT EXISTS broker_close_transaction_id text,
  ADD COLUMN IF NOT EXISTS close_requested_at timestamptz;
