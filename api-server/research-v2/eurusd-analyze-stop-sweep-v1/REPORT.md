# EURUSD Analyze stop-loss sweep

Retrospective research only. No stop guarantees profits. This grid was not evaluated on unseen history.

Sample: 2025-10-13T00:00:00.000Z to 2026-10-13T00:00:00.000Z. Split: 2026-07-13T18:00:00.000Z.

Tested each fixed distance from 1 through 500 pips (1-pip steps) and 0.1 through 70 ATR (0.1-ATR steps), plus the no-stop baseline, in both modes: 2,400 stop/mode combinations. The initial 0.1–10 ATR sweep was expanded because baseline adverse excursions reached 63.04 entry ATR. Beyond the observed maximum, stops do not activate in the original full-sample book. This is a finite grid, not every possible continuous level or exit design.

The original trend, 1.5-entry-ATR pullback, 14-day losing timeout, fixed size, spreads, 0.2-pip per-side slippage, financing estimates and margin model stay fixed. After a stop, the account can enter again on a subsequent completed primary signal; trade counts and entries can therefore change.

Stops are fixed from the actual fill price, never trailed. Activation uses raw bid/ask high/low and fills at the stop plus slippage or a worse opening gap. Entry-bar stops are checked. Intrabar fills are timestamped at the candle end and charged financing through that time; no tick path is invented. Floating drawdown ends at the stop fill on a stopped bar. If a margin threshold is closer, margin wins and the account halts.

Each period is a separate account, starting flat with $10,000 and fixed 10,000 EUR units. Partial-period open trades are marked to market. Training/validation returns will not sum to the full-run result because account boundary positions and entry availability differ.

## No-stop baseline

| Mode | Stop | Net P&L | Return | Max drawdown | Closed trades | Win rate | PF | First 75% net | Last 25% net |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NORMAL | No stop | −$912.96 | -9.13% | 11.05% | 95 | 80.0% | 0.56 | −$223.26 | −$505.56 |
| SWING | No stop | −$577.71 | -5.78% | 9.50% | 33 | 63.6% | 0.61 | −$628.27 | +$39.63 |

## Highest full-sample net profit (in-sample winners)

### NORMAL

| Mode | Stop | Net P&L | Return | Max drawdown | Closed trades | Win rate | PF | First 75% net | Last 25% net |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NORMAL | 25 ATR | −$248.05 | -2.48% | 6.11% | 121 | 85.1% | 0.86 | −$245.16 | −$15.70 |
| NORMAL | 29.2 ATR | −$257.33 | -2.57% | 6.53% | 111 | 84.7% | 0.85 | −$343.55 | −$86.04 |
| NORMAL | 29.3 ATR | −$259.84 | -2.60% | 6.55% | 111 | 84.7% | 0.85 | −$344.94 | −$87.02 |
| NORMAL | 29.4 ATR | −$262.35 | -2.62% | 6.57% | 111 | 84.7% | 0.85 | −$346.32 | −$88.01 |
| NORMAL | 29.5 ATR | −$267.35 | -2.67% | 6.59% | 111 | 84.7% | 0.85 | −$347.71 | −$91.49 |
| NORMAL | 29.6 ATR | −$269.86 | -2.70% | 6.61% | 111 | 84.7% | 0.85 | −$349.10 | −$92.48 |
| NORMAL | 29.7 ATR | −$272.36 | -2.72% | 6.62% | 111 | 84.7% | 0.85 | −$350.48 | −$93.47 |
| NORMAL | 29.8 ATR | −$274.87 | -2.75% | 6.64% | 111 | 84.7% | 0.84 | −$351.87 | −$94.45 |
| NORMAL | 29.9 ATR | −$277.38 | -2.77% | 6.66% | 111 | 84.7% | 0.84 | −$353.26 | −$95.44 |
| NORMAL | 30 ATR | −$279.88 | -2.80% | 6.68% | 111 | 84.7% | 0.84 | −$354.64 | −$96.43 |

### SWING

| Mode | Stop | Net P&L | Return | Max drawdown | Closed trades | Win rate | PF | First 75% net | Last 25% net |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SWING | 3.9 ATR | +$430.10 | 4.30% | 5.12% | 46 | 69.6% | 1.30 | −$13.49 | +$239.41 |
| SWING | 4 ATR | +$403.52 | 4.04% | 5.29% | 46 | 69.6% | 1.27 | −$38.42 | +$233.79 |
| SWING | 4.1 ATR | +$376.84 | 3.77% | 5.46% | 46 | 69.6% | 1.25 | −$63.45 | +$228.17 |
| SWING | 4.2 ATR | +$340.82 | 3.41% | 5.87% | 45 | 68.9% | 1.22 | −$97.82 | +$306.34 |
| SWING | 3.8 ATR | +$275.45 | 2.75% | 4.94% | 46 | 65.2% | 1.16 | −$222.65 | +$297.93 |
| SWING | 1.5 ATR | +$193.67 | 1.94% | 5.21% | 75 | 45.3% | 1.12 | −$113.32 | +$306.99 |
| SWING | 1.2 ATR | +$174.05 | 1.74% | 4.40% | 86 | 39.5% | 1.10 | −$158.35 | +$332.41 |
| SWING | 48 pips | +$161.01 | 1.61% | 5.87% | 63 | 50.8% | 1.10 | −$130.71 | +$291.72 |
| SWING | 4.3 ATR | +$159.61 | 1.60% | 6.04% | 43 | 67.4% | 1.08 | −$277.39 | +$302.48 |
| SWING | 1.6 ATR | +$151.22 | 1.51% | 5.77% | 75 | 46.7% | 1.09 | −$145.46 | +$296.68 |

## Chronological selection check

Select the largest first-75% net profit; ties prefer lower drawdown, then the smaller numerical stop. Test that choice on the last 25% without changing it. This is a retrospective check, not untouched out-of-sample evidence.

NORMAL: selected **63.1 ATR**, development −$223.26, validation **−$722.09** (-7.22%), 11 closed trades, max DD 8.83%.
SWING: selected **3.9 ATR**, development −$13.49, validation **+$239.41** (2.39%), 11 closed trades, max DD 2.32%.

## Profitability and sensitivity

NORMAL pips: 0/500 full-sample profitable; 0/500 profitable in both chronological periods.
NORMAL atr: 0/700 full-sample profitable; 0/700 profitable in both chronological periods.
SWING pips: 26/500 full-sample profitable; 0/500 profitable in both chronological periods.
SWING atr: 28/700 full-sample profitable; 0/700 profitable in both chronological periods.

Estimated financing and a simplified margin model remain limitations. Original history has 192 M15 gaps flagged by the market-open calendar; no synthetic bars are inserted. Very tight stops are especially sensitive to actual spread, slippage and execution latency.

Inspect neighboring levels in RESULTS.csv rather than promoting a single peak. Finalist trade ledgers (best fixed-pip and ATR level per mode) are in FINALISTS.json. Any level chosen after inspecting this whole grid needs new forward evidence. Preserve this sweep; do not claim parameter selection as validation.

Reproduce: `npm --workspace api-server run eurusd:analyze-stop-sweep`. Reads and verifies the existing baseline cache; no network or broker orders.
