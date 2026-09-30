-- Exact execution costs as reported by OANDA's ORDER_FILL transaction. These
-- are deliberately separate from strategy-time spread_pips/spread_cost_r,
-- which are estimates recorded before the broker fills the order.
ALTER TABLE practice_order_intents
  ADD COLUMN IF NOT EXISTS entry_half_spread_cost numeric,
  ADD COLUMN IF NOT EXISTS entry_commission numeric,
  ADD COLUMN IF NOT EXISTS entry_guaranteed_execution_fee numeric;

COMMENT ON COLUMN practice_order_intents.entry_half_spread_cost IS
  'OANDA ORDER_FILL tradeOpened.halfSpreadCost in the account home currency.';
