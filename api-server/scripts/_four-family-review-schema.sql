SELECT table_name, column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND (table_name IN ('paper_strategy_trades','paper_strategy_evaluations','practice_orders','paper_strategy_experiments') OR table_name LIKE '%adaptive%')
ORDER BY table_name,ordinal_position;
