# AUDUSD strategy decision

## Final status

- Active source strategy: **GX AUDUSD Strong Consensus Structure V1**
- V1 status: **AUDUSD_V1_FROZEN**
- V2 lifecycle: **RESEARCH_ONLY**
- V2 cost classification: **MARGINAL_AFTER_COSTS**
- V2 replacement decision: **REJECTED_REPLACEMENT**
- Final V2 status: **AUDUSD_V2_REJECTED**

GX AUDUSD Strong Consensus Structure V2 - HL Only failed as a production replacement. It must not be deployed or promoted.

## Frozen V1 entry and exit contract

- Pair: `AUD_USD`
- Timeframe: H1
- Origin: completed 11:00 UTC candle
- Direction: long only
- Consensus: the six original causal votes with vote sum at least +4
- Required external structure: higher high **and** higher low (`high > previous high && low > previous low`)
- HL-only structure is not eligible
- ATR: frozen ATR14 at entry
- Stop: 1 ATR
- Target: 2R
- Maximum hold: three future H1 bars
- BODY + EXTREME: metadata only; it does not filter baseline entries
- No shorts, trailing stop, break-even, or partial exits

## Evidence supporting rejection

| Metric | Validated V1 | V2 HL-only executable |
|---|---:|---:|
| Trades | approximately 195 | 219 |
| Win rate | 45.64% | 44.29% |
| Profit factor | 1.232 | 1.100 |
| Expectancy | +0.118R/trade | +0.055R/trade |
| Maximum drawdown | — | 14.10R |

V2 incurred average execution drag of 0.141R/trade and total execution drag of 30.79R. Nine midpoint winners became executable losses, and five midpoint targets were not reached by executable BID. Results were negative in 2023 and 2025 and relied heavily on 2026. The V1-comparable executable-centered diagnostic also remained below V1 at +0.089R/trade and PF 1.169.

All V2 source, validation, trade-level, raw-result, and gap-audit artifacts in this directory are intentionally retained as historical research evidence.

No deployment, database migration, or broker order is part of this decision record.
