VERDICT:
POC_NEUTRAL

# EURUSD H1 EMA PULLBACK + YESTERDAY POC A/B TEST

Paper trading / research only. Nothing was deployed. No production strategy was modified. Rules were frozen before P&L was inspected. POC bin count, EMA lengths, stops, and RR were not searched.

## DATA

Period: 2019-01-01T22:00:00.000000000Z → 2026-09-04T20:00:00.000000000Z (request 2019-01-01T00:00:00.000Z to 2026-09-05T00:00:00.000Z)
H1 candles: 47797
M5 candles: 572202
Raw opportunities: 2458
Fresh validation opportunities: 2258 (first 200 raw opportunities = DEV)

### VERSION A — NO POC

- Trades: 1119
- Trades/year: 146.18
- WR: 39.77% (445/1119)
- PF: 1.036
- Net $: 11.82
- Net %: 11.82%
- Net R: 26.918
- Expectancy $: 0.0106
- Expectancy R: 0.0241
- Avg R/trade: 0.0241
- Median R/trade: -1.0000
- Ending $100 account: 111.82
- Max DD $: 25.57
- Max DD %: 21.50%
- Max DD R: 46.857
- Max consec wins/losses: 9/15
- Avg/median hold hours: 15.11 / 8.42
- TIME_EXIT_48H: 95
- WEEKEND_EXIT: 167

### VERSION B — WITH POC

- Trades: 928
- Trades/year: 121.23
- WR: 40.41% (375/928)
- PF: 1.058
- Net $: 15.93
- Net %: 15.93%
- Net R: 33.249
- Expectancy $: 0.0172
- Expectancy R: 0.0358
- Avg R/trade: 0.0358
- Median R/trade: -1.0000
- Ending $100 account: 115.93
- Max DD $: 12.67
- Max DD %: 10.44%
- Max DD R: 21.845
- Max consec wins/losses: 10/11
- Avg/median hold hours: 16.08 / 10.04
- TIME_EXIT_48H: 85
- WEEKEND_EXIT: 158


## POC EFFECT

Trades blocked (A-eligible, B `BLOCKED_BY_POC`): 330
% of A trades removed by occupancy-aware B vs A: 17.07%
A trades/year: 146.18
B trades/year: 121.23

Blocked trades' hypothetical (same path as A-eligible, occupancy ignored):
- n: 330
- WR: 35.15%
- PF: 0.882
- Net R: -24.684
- Expectancy R: -0.0748

B-surviving opportunities (A-eligible and POC-allowed), hypothetical:
- n: 1403
- WR: 39.77%
- PF: 1.074
- Net R: 56.860
- Expectancy R: 0.0405

### LONG POC effect

Allowed: n=691 WR=37.48% PF=0.934 netR=-26.099 exp=-0.0378
Blocked: n=166 WR=33.73% PF=0.838 netR=-17.431 exp=-0.1050

### SHORT POC effect

Allowed: n=712 WR=41.99% PF=1.224 netR=82.959 exp=0.1165
Blocked: n=164 WR=36.59% PF=0.928 netR=-7.253 exp=-0.0442

## LONG vs SHORT (account occupancy)

A LONG: n=574 WR=38.85% PF=1.007 netR=4.757 exp=0.0083
A SHORT: n=545 WR=40.73% PF=1.068 netR=22.161 exp=0.0407
B LONG: n=474 WR=39.45% PF=1.013 netR=4.668 exp=0.0098
B SHORT: n=454 WR=41.41% PF=1.107 netR=28.581 exp=0.0630

## FRESH VALIDATION

A WR: 39.75%
A PF: 1.032
A expectancy: 0.0215

B WR: 40.65%
B PF: 1.059
B expectancy: 0.0364

DEV checkpoint after 100 raw opportunities: A expR=0.1186 B expR=0.1223
DEV after 200: A expR=0.0575 B expR=0.0284

## STATISTICAL UNCERTAINTY

- A WR 95% Wilson CI: 36.94% – 42.67%
- B WR 95% Wilson CI: 37.30% – 43.60%
- Bootstrap difference in expectancy R (B − A, account trades): mean 0.0115, 95% -0.1000 to 0.1225
- Paired opportunity-level (B takes R or 0) minus A R: mean 0.0162, 95% -0.0114 to 0.0423

Tiny numerical gaps inside these intervals are **not** superiority.

## EXECUTION

Average spread (raw opportunities with quotes): 1.602 pips
Spread-blocked: 707
Position-blocked A/B: 875 / 751
Commission: **0** explicit (OANDA instrument snapshot has no per-trade commission field used here; spread is still modeled)
Slippage assumption (authoritative): ACTUAL_BID_ASK_BASELINE (0 extra pips). Stress in COST_STRESS_RESULTS.csv.
Financing: FINANCING_DATA_UNAVAILABLE historically. Current snapshot longRate=-0.0244 shortRate=0.0042 (https://api-fxpractice.oanda.com current snapshot, not historical). Average OANDA-style days charged if NY 17:00 rolls applied: 0.96. Baseline P&L does **not** subtract this.
Margin: enforced at rate 0.02 (https://api-fxpractice.oanda.com current snapshot, not historical)
Intrabar ambiguity: 0 trades flagged; see INTRABAR_REPORT.md
Units precision: floor to whole units (never rounded up)

## YEARLY STABILITY

See YEARLY_RESULTS.csv. Do not let one year hide the rest.

## EQUITY

See EQUITY_CURVES.csv. Both versions start at exactly $100 with 0.5% current-equity risk. Normalized R columns are included so compounding does not hide trade quality.

## FINAL ANSWER

Classification reason: POC changed trade count more than it changed trade quality.

1. Is the BASE strategy profitable after realistic costs? **YES, on this bid/ask baseline** (expR=0.0241, PF=1.036, end=111.82)
2. Is the POC version profitable after realistic costs? **YES, on this bid/ask baseline** (expR=0.0358, PF=1.058, end=115.93)
3. Does POC actually improve expectancy? **Higher on the account path** (A 0.0241R vs B 0.0358R). Opportunity-level blocked vs allowed: blocked exp -0.0748 vs allowed 0.0405.
4. Does POC reduce drawdown? **YES** (A 21.50% vs B 10.44%)
5. How much trade frequency does POC remove? **17.07%** of A's closed trades (A 146.18/yr vs B 121.23/yr)
6. Does the improvement survive fresh data? **B still higher expectancy on FRESH**
7. Does POC help LONG, SHORT, BOTH, or NEITHER? **BOTH** (opportunity-level allowed vs blocked expectancy)
8. Which version should remain a research candidate: **BOTH**

Do not deploy anything.
