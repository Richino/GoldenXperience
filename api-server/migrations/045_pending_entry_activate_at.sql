-- Time-gated activation ("submit after") for manual pending entries.
-- When activate_at is set and in the future, the entry stays dormant: it is not
-- submitted to OANDA and the price monitor will not trigger it until the time
-- passes. NULL means submit immediately (the previous behavior).
ALTER TABLE pending_manual_entries
  ADD COLUMN IF NOT EXISTS activate_at timestamptz;

-- Lets the activation job find dormant entries that are now due.
CREATE INDEX IF NOT EXISTS pending_manual_entries_activation_idx
  ON pending_manual_entries(activate_at)
  WHERE status = 'PENDING' AND activate_at IS NOT NULL;
