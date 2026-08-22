-- Practice order intents: tell a rejected order from a live one.
--
-- OANDA answers 201 for an order it accepts and immediately cancels, so an
-- INSUFFICIENT_MARGIN rejection arrived looking like a success. The submitter
-- read only orderCreateTransaction/orderFillTransaction, so it stored
-- status='submitted' with a NULL broker_trade_id: a row claiming a position
-- that was never opened.
--
-- That claim then deadlocked the close path. closePracticeTradeForPaperTrade
-- refuses to act without a broker_trade_id, so the forced 16:45 ET exit could
-- never be sent, the internal trade stayed open forever, and an open trade
-- freezes both its instrument (one position per instrument) and its batch (a
-- batch files only when every trade closes). Four instruments and three
-- batches were stranded this way.
--
-- Reconciliation against the practice account on 2026-08-22 confirmed the
-- broker holds no open trades and no open positions, so every one of these
-- rows is a rejection and nothing is being abandoned by reclassifying them.

ALTER TABLE practice_order_intents DROP CONSTRAINT IF EXISTS practice_order_intents_status_check;

ALTER TABLE practice_order_intents
  ADD CONSTRAINT practice_order_intents_status_check
  CHECK (status IN ('pending','sending','submitted','failed','unknown','disabled','rejected'));

-- Reclassify the historical rejections. 'submitted' with no broker trade id is
-- exactly the signature of an order the broker refused: a filled order always
-- carries the trade it opened.
UPDATE practice_order_intents
SET status = 'rejected',
    failure_reason = COALESCE(failure_reason, 'Broker did not open a position (reclassified from submitted; no broker_trade_id).'),
    updated_at = now()
WHERE status = 'submitted'
  AND broker_trade_id IS NULL;

-- The paper trades left open by the deadlock are deliberately NOT closed here.
-- Their exits are not this migration's to invent: with the intents corrected,
-- closePracticeTradeForPaperTrade now reports "nothing open at the broker" and
-- the normal resolver closes each one on the next cycle, at real prices, by the
-- same horizon and forced-close rules as every other trade.
