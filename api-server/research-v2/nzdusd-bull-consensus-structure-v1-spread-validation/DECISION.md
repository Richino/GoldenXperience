# NZDUSD Bull Consensus Structure V1 — frozen research decision

Status: **FROZEN_RESEARCH_CANDIDATE**  
Validation: **SURVIVES_COSTS**  
Classification: **STRONG**

The exact TradingView cohort contains 102 trades. OANDA Practice bid/ask M1 replay fully matched 100; those trades produced 48.00% win rate, 1.380 PF, +0.1898R per trade, and +18.9782R total. This materially improves on the prior NZDUSD executable benchmark of -0.094R per trade.

The two unresolved OANDA M1 records remain evidence, not exclusions: trade 47 is missing two minutes beginning 2024-07-04T12:27:00.000Z, and trade 85 is missing one minute beginning 2025-12-22T14:11:00.000Z. Three OANDA/TradingView geometry discrepancies (trades 27, 72, and 78) are also preserved in `RAW_RESULTS.json` and `REGISTRY.json`. No candles, prices, ATR values, stop/target values, or outcomes were fabricated to force parity.

The frozen V1 remains the four-vote bullish consensus threshold of >= +3, HH + HL, 1 frozen ATR14 stop, 2R target, and three future H1 bars. No Phase-4 filter, exit redesign, year filter, or other rule optimization is authorized by this result.

This is not an activation decision. The existing runtime `NZDUSD_PRE_RANGE_BREAKOUT_V1` configuration is a separate strategy and was not modified. This Bull Consensus Structure V1 candidate has no deployment, live execution, or broker orders.
