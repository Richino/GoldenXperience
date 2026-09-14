ALTER TABLE notification_events
  DROP CONSTRAINT IF EXISTS notification_events_kind_check;

ALTER TABLE notification_events
  ADD CONSTRAINT notification_events_kind_check
  CHECK (kind IN ('setup_ready', 'paper_opened', 'paper_closed', 'trade_update', 'system_issue'));
