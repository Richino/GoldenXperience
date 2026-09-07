SELECT 'risk_units' kind,jsonb_agg(to_jsonb(x)) data FROM
(SELECT t.trade_sequence,t.strategy_family,t.result_basis,t.outcome,t.result_r,t.nominal_risk_amount,t.calculated_units,
i.request_payload->'units' submitted_units,t.entry,t.stop,t.exit,
(CASE WHEN t.direction='long' THEN t.exit-t.entry ELSE t.entry-t.exit END)/nullif(abs(t.entry-t.stop),0) geometry_r
FROM paper_strategy_trades t JOIN practice_order_intents i ON i.paper_trade_id=t.id
WHERE t.strategy_family IN ('ema','breakout','momentum','meanrev') AND t.result_basis='broker' ORDER BY t.trade_sequence) x
UNION ALL
SELECT 'snapshot_drift',jsonb_agg(to_jsonb(x)) FROM
(SELECT t.strategy_family,count(*)::int n,count(*) FILTER(WHERE e.setup_status='no_setup')::int selected_now_no_setup,
count(*) FILTER(WHERE t.direction<>e.direction)::int direction_mismatch,
count(*) FILTER(WHERE t.entry<>e.entry)::int entry_mismatch
FROM paper_strategy_trades t JOIN paper_strategy_evaluations e ON e.id=t.evaluation_id
WHERE t.strategy_family IN ('ema','breakout','momentum','meanrev') GROUP BY 1) x;
