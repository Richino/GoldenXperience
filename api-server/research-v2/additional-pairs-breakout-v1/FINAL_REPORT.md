# Additional pairs: frozen Breakout V1 development screen

Research only. Existing four strategies unchanged; NZD/USD excluded. No deployments, settings changes or orders.

Development: 2023–2024 with a 48-hour entry purge. Completed historical OANDA M15 bid/ask; unchanged generic Breakout V1 entry rules and executable +2R target/-1R stop geometry. Stop-first ambiguity, adverse opening stop gaps, same-day 16:45 New York exit, one open trade per pair. This is a separate generic baseline, not a copy of the four pair-specific strategies.

| Pair | N | WR | TP | SL | TIME | PF | Exp R | Total R | Closed DD R | 2023 exp | 2024 exp | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| USD_CAD | 625 | 31.4% | 144 | 401 | 80 | 0.779 | -0.146 | -91.115 | 105.429 | -0.110 | -0.233 | DATA_INCOMPLETE |
| USD_CHF | 874 | 28.1% | 179 | 583 | 112 | 0.675 | -0.223 | -194.758 | 199.039 | -0.210 | -0.236 | DEVELOPMENT_FAIL_DO_NOT_ADMIT |
| EUR_JPY | 425 | 38.4% | 107 | 229 | 89 | 1.048 | 0.027 | 11.581 | 23.200 | 0.027 | 0.029 | DATA_INCOMPLETE |
| GBP_JPY | 125 | 32.0% | 30 | 75 | 20 | 0.847 | -0.098 | -12.220 | 23.753 | -0.104 | -0.083 | DATA_INCOMPLETE |

## Interpretation and limitations

Admission requires N >=100, each year N >=40 and positive expectancy, pooled expectancy >=0.10R, PF >=1.15, a positive lower 95% calendar-month bootstrap bound, and no unresolved trades. These gates were saved before fetching development data. Passing would only authorize the next research stage, not execution.

The 2025–2026 validation period has not been replayed. It is not asserted to be globally untouched by previous research. Negative development results are not tuned or reversed. The raw full dataset is cached separately from result artifacts and identified by hashes.

Historical news filters are unavailable. Signal-close entry assumes zero latency. No extra slippage, commissions or financing are charged; gaps at stops can exceed -1R. Drawdown is closed-trade R drawdown, not marked-to-market account drawdown. Midpoint results are only a same-entry-time/fixed-barrier cost diagnostic, never the admission basis. The failed low-spread selector was not applied.

This stage does not simulate a 3% USD account: crossing currency conversion, actual instrument margin, correlated concurrent exposure and realistic order sizing must be modeled before any addition to the earlier account simulation. More pairs alone are not evidence of greater profit.

Recommendation: admit none of these additional pairs under this baseline. Keep the existing controls unchanged; do not tune this losing baseline or reuse later years to rescue it.
