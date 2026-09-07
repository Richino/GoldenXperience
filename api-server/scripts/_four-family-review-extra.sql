SELECT 'schema' AS kind,jsonb_agg(to_jsonb(x)) AS data FROM
(SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE '%momentum%arm%' OR table_name LIKE '%practice%order%') ORDER BY table_name,ordinal_position) x
UNION ALL
SELECT 'funnel',jsonb_agg(to_jsonb(x)) FROM
(SELECT strategy_family,setup_status,execution_status,count(*)::int n,min(decision_time) first,max(decision_time) last FROM paper_strategy_evaluations
WHERE decision_time>='2026-08-31' AND strategy_family IN ('ema','breakout','momentum','meanrev') GROUP BY 1,2,3) x
UNION ALL
SELECT 'blocks',jsonb_agg(to_jsonb(x)) FROM
(SELECT strategy_family,rejection_reason,count(*)::int n FROM paper_strategy_evaluations
WHERE decision_time>='2026-08-31' AND strategy_family IN ('ema','breakout','momentum','meanrev') AND setup_status='valid' AND execution_status<>'selected' GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 20) x;
