-- A manual OANDA pending entry already owns the same broker trade through
-- pending_manual_entries.metadata.brokerTradeId. Remove only the synthetic
-- history-import row created for that identical trade; retain the linked manual
-- record with its planned levels, actual exit, P/L, and R.
DELETE FROM paper_trades AS synthetic
USING pending_manual_entries AS linked
WHERE synthetic.user_id = linked.user_id
  AND synthetic.legacy_id = 'oanda-trade:' || (linked.metadata->>'brokerTradeId')
  AND linked.metadata->>'brokerTradeId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM paper_trade_events event WHERE event.paper_trade_id = synthetic.id
  );
