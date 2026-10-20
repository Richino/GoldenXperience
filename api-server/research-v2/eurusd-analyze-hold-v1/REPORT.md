# EURUSD Analyze hold backtest

Research only; retrospective exploratory results, not a validated strategy.

Requested: 2025-10-13T00:00:00.000Z to 2026-10-13T00:00:00.000Z. Actual M15 coverage: 2025-10-13T00:00:00.000Z to 2026-10-13T00:00:00.000Z.

Independent USD accounts: $10000.00 each, 10000 fixed EUR units, 30:1 maximum leverage. Losing hold 14 calendar days. Pullback 1.5 entry ATR.

Observed bid/ask spread + 0.2 pips slippage per side. Financing estimate: long 5% / short 5% annually. Commission 0 USD per million USD notional per side.

| Mode | Closed / open | Win rate | Closed PF | Total net P&L | Return | Floating-inclusive max DD | Worst closed loss | Max hold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NORMAL | 95 / 1 | 80.0% | 0.56 | $-912.96 | -9.13% | $1128.63 (11.05%) | $-298.57 | 14.00d |
| SWING | 33 / 1 | 63.6% | 0.61 | $-577.71 | -5.78% | $956.88 (9.50%) | $-325.46 | 24.17d |

NORMAL: exits {"major_pullback":79,"loss_timeout":16,"margin_closeout":0,"open":1}; financing $571.66; largest adverse excursion 347.3 pips; missing market-open M15 bars 192; halted false.
SWING: exits {"major_pullback":20,"loss_timeout":13,"margin_closeout":0,"open":1}; financing $516.91; largest adverse excursion 440.4 pips; missing market-open M15 bars 192; halted false.

## Rules and limitations

- **trend:** Same readMarketFoundation primary trend as live Analyze V2. Trend-only entries bypass its trade checklist. Higher alignment is recorded, not a filter.
- **fills:** Signal on completed candle, fill at next M15 open. Ask buy / bid sell plus slippage on each side. Entry expires across a gap.
- **losses:** No stop loss. If net P&L <= 0 at any M15 close at/after holdDays from entry, exit next available open. Profitable trades may exceed holdDays.
- **winners:** Primary close retreats pullbackAtr * fixed entry ATR from best favorable primary close since entry, AND net P&L > 0; exit next M15 open. Gap may make the realized exit a loss.
- **finance:** Signed annualized opening USD notional / 365, accrued over calendar time including weekends. Positive rate is a charge. Estimate, not historical OANDA roll/swap rates.
- **margin:** Fixed opening notional / leverage required for entry. Liquidate at NAV <= closeoutFraction * opening margin (worst open for gaps); halt account afterward. Simplified, not exact OANDA rules.
- **drawdown:** Close-equity peaks against every M15 adverse extreme, including floating losses and estimated exit costs. Conservative bar approximation.
- **news:** No historical news filter; calendar is not consulted for trend-only entries.
- **sample:** Retrospective exploratory sample. Analyze was developed on overlapping history; no claim of unseen/out-of-sample validation.
- **end:** Remaining position marked to market with estimated exit costs, kept separate from closed-trade win rate and profit factor.

No parameter tuning was performed by this runner. Exact inputs and code hashes are in RESULTS.json. Equity CSVs are regenerable local artifacts.
