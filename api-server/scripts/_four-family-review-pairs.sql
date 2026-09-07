SELECT 'pairs' kind,jsonb_agg(to_jsonb(x)) data FROM
(SELECT o.pair_id,o.instrument,o.decision_time,o.session,o.regime,o.status original_status,i.status inverted_status,
o.net_result_r original_r,i.net_result_r inverted_r,o.executed original_executed,i.executed inverted_executed,
o.outcome_source original_source,i.outcome_source inverted_source,o.outcome original_outcome,i.outcome inverted_outcome
FROM momentum_inversion_arms o JOIN momentum_inversion_arms i ON i.pair_id=o.pair_id AND i.arm='inverted' WHERE o.arm='original' ORDER BY o.decision_time) x
UNION ALL
SELECT 'selection',jsonb_agg(to_jsonb(x)) FROM
(SELECT adaptive_state,reason,count(*)::int n FROM adaptive_decisions WHERE decision_time>='2026-08-31' AND candidates::text LIKE '%breakout%' GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 20) x
UNION ALL
SELECT 'broker',jsonb_agg(to_jsonb(x)) FROM
(SELECT t.strategy_family,t.result_basis,i.status order_status,count(*)::int n,avg(t.net_result_r) net_e,avg(t.result_r) result_e,avg(t.gross_result_r) gross_e,avg(t.total_cost_r) costs,
min(t.opened_at) first,max(t.opened_at) last FROM paper_strategy_trades t LEFT JOIN practice_order_intents i ON i.paper_trade_id=t.id WHERE t.strategy_family IN ('ema','breakout','momentum','meanrev') GROUP BY 1,2,3) x;
