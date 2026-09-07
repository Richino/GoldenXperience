# STRATEGY SPEC — EURUSD H1 EMA pullback ± yesterday POC A/B

**Experiment ID:** `eurusd-h1-ema-pullback-poc-ab-v1`  
**Status:** PAPER TRADING / RESEARCH ONLY. Not deployed. Not registered for live or paper execution. No production GoldenXperience strategy is modified.  
**Frozen:** yes. No parameter search. No post-result rule changes.

This document is written **before** profitability is evaluated.

## Research question

Does **yesterday’s POC** (previous completed UTC calendar day) improve a simple EURUSD H1 EMA trend-pullback swing strategy?

Two versions share every rule except one directional entry filter:

| Version | POC |
|---|---|
| **A** BASE | none |
| **B** POC | enter long only if signal close > yesterday POC; enter short only if signal close < yesterday POC |

POC must not change stop, target, size, trend, pullback, risk, spread filter, or exits.

## Instrument and timeframe

- Instrument: OANDA `EUR_USD` / EURUSD
- Decision timeframe: **H1 completed candles only**
- No intrabar signal generation
- No London/New York session filter
- Not scalping, not binary, not M1/M5 day-trading optimization
- Maximum hold: **48 hours** wall-clock, then the first executable H1 decision point at or after that instant
- Swing trades may remain open overnight; they **must not** remain open across the weekly OANDA shutdown

## Accounts

Each version has an independent simulated account.

- Starting balance: **$100** each
- Risk: **0.5% of current equity** per trade (`riskDollars = balance × 0.005`)
- Risk compounds with the closed-trade balance
- One open position **per version**. A never blocks B. B never blocks A.

## Indicators (only these)

On H1 **midpoint close**:

- EMA 20
- EMA 50

Ordinary EMA: SMA of the first `period` closes as the seed, then `α = 2/(period+1)`.  
Implementation: same recurrence as `frontend/src/lib/strategy/indicators.ts` `calculateEmaValues`.

No ADX, RSI, MACD, ATR stops, or extra trend filters.

## Trend

Evaluated on completed H1 bar `t` (0-based index into the sorted completed H1 series).

```
trendLong  = ema20[t] > ema50[t] AND ema50[t] > ema50[t-5]
trendShort = ema20[t] < ema50[t] AND ema50[t] < ema50[t-5]
```

`ema50[t-5]` is the EMA50 value from **exactly five completed H1 bars ago**, not five calendar hours if bars are missing.

## Pullback signals (raw base opportunity)

After bar `t` completes, using H1 **mid** OHLC:

```
LONG_SIGNAL =
  trendLong
  AND low[t]  <= ema20[t]
  AND close[t] > ema20[t]
  AND close[t] > high[t-1]

SHORT_SIGNAL =
  trendShort
  AND high[t]  >= ema20[t]
  AND close[t] < ema20[t]
  AND close[t] < low[t-1]
```

Every `LONG_SIGNAL` / `SHORT_SIGNAL` is a **raw opportunity**, even if a version is already in a trade.

## Stop (structure, frozen at signal)

Using the last three **completed** H1 bars including the signal bar, midpoint highs/lows:

```
threeBarLow  = min(low[t], low[t-1], low[t-2])
threeBarHigh = max(high[t], high[t-1], high[t-2])
PIP          = 0.0001
LONG_STOP    = threeBarLow  - 0.0002
SHORT_STOP   = threeBarHigh + 0.0002
```

The stop is not trailed, not moved to breakeven, and not widened after entry.

## Entry

Signals are known only after bar `t` is complete. Entry is **not** the signal close unless that price is the next executable quote.

Entry = first executable quote after the signal bar’s period ends:

- LONG: **ASK open** of the next available MBA bar (H1 open, which equals the first M5/M1 open at that timestamp)
- SHORT: **BID open** of that same bar

Record: signal timestamp, signal close, actual entry timestamp, executable entry.

## Invalid geometry

After the actual executable entry (including any labeled slippage scenario):

- LONG requires `entry > stop`
- SHORT requires `entry < stop`

Otherwise skip and log `INVALID_STOP_GEOMETRY`.

## Target (1:2 from executable entry)

```
riskDistance = abs(actualEntry - stop)
LONG  target = entry + 2 × riskDistance
SHORT target = entry - 2 × riskDistance
```

## Spread filter (both versions)

At the entry bar, before accepting:

```
spread         = ask.open - bid.open
stopDistance   = abs(executableEntry - stop)
spreadFraction = spread / stopDistance
```

Skip if `spreadFraction > 0.10`. Log `SPREAD_TOO_WIDE` with spread price, spread pips, stop pips, and spread/stop.

## Version B only — POC filter

Uses **signal H1 mid close** vs yesterday’s frozen POC (see `POC_SPEC.md`).

```
B LONG  extra: signalClose > yesterdayPOC
B SHORT extra: signalClose < yesterdayPOC
```

If the base signal is otherwise valid for B but the close is on the wrong side of POC, log `BLOCKED_BY_POC`.  
If yesterday POC cannot be computed, B does **not** enter. Log `POC_UNAVAILABLE`. That is not an A/B rule change; it is a missing-input skip.

POC does not modify stop, target, size, or exits.

## Position sizing

OANDA units of EUR. EURUSD quote currency is USD, so:

```
pnlUsd        = units × (exitPrice - entryPrice) × directionSign
riskDollars   = balanceBefore × 0.005
stopDistance  = abs(entry - stop)
rawUnits      = riskDollars / stopDistance
units         = floor(rawUnits) down to whole units (precision 0)
actualRisk    = units × stopDistance
pipValueUsd   = units × 0.0001
```

Never round units up. If `units < 1`, skip (`UNITS_TOO_SMALL`).

Record: balance before entry, risk dollars, entry, stop, stop pips, units, pip value, actual modeled risk.

## Margin

If OANDA instrument `marginRate` is available at run time, required margin is:

```
requiredMargin = units × entry × marginRate
```

Skip with `INSUFFICIENT_MARGIN` when `requiredMargin > current balance` (no other positions exist on that version’s account).  
If the live snapshot is unavailable, use the existing GX paper-account fallback `marginRate = 0.02` and state that it is a current/assumed rate, not a historical series.

## Exits (first event wins)

Executable exit side:

- LONG exit through **BID**
- SHORT exit through **ASK**

Events:

1. **STOP** — exit side trades through the stop. Adverse gap: fill at the worse executable open.
2. **TARGET** — exit side trades through the target. Target gaps are filled at the **target** (no improvement beyond 2R).
3. **TIME_EXIT_48H** — first H1 bar **open** with `openTime >= entryTime + 48h`. Close at that bar’s executable open (bid for long, ask for short).
4. **WEEKEND_EXIT** — do not hold across the weekly gap. Implementation: last MBA bar whose **next** bar in the same series is ≥ 12 hours later (OANDA weekend gap). Close at that last bar’s executable **close**. This uses the actual quote calendar, not a hard-coded UTC hour, so DST is handled by the gap itself.

If stop and target are both touched inside one H1 (or M5) bar, **do not** award the favorable fill. Resolve with M1 bid/ask path when available; otherwise conservative **stop-first**. Log `AMBIGUOUS_INTRABAR` and the resolution method.

## Costs

### Commission

OANDA practice FX on this account is a **spread-only** pricing model. Explicit commission = **0**. Spread is still a real cost because entries and exits use bid/ask.

### Slippage

Official baseline: `ACTUAL_BID_ASK_BASELINE` — historical bid/ask, **0 extra synthetic pips**.

Labeled stress (against the trader, identical for A and B):

- 0.0 pip/side (baseline)
- 0.1 pip/side
- 0.2 pip/side
- 0.5 pip/side

LONG: entry higher, exit lower. SHORT: entry lower, exit higher.

### Financing

Historical OANDA swap/financing rates are **not** stored in this research repo. They will **not** be invented. Baseline P&L is bid/ask only. Overnight roll **counts** (New York 17:00, Wednesday ×3) may be used only for separately labeled conservative sensitivity. Authoritative financing = `FINANCING_DATA_UNAVAILABLE`.

## A/B fairness

A and B see the same H1/M5/M1 history, same EMA, same raw signals, same spread, same sizing formula, same stops/targets, same cost assumptions, same `$100` start, same date range. **POC filter is the only strategic difference.** Occupancy can still cause the accepted **trade lists** to diverge after a POC block; that is expected. Opportunity-level counterfactuals (what a blocked signal would have done) are reported separately so occupancy does not hide the POC effect.

## Sample split (frozen before results)

- **DEV:** first **200** raw base opportunities in chronological order (also report a 100-opportunity checkpoint).
- **FRESH:** all later raw opportunities. No rule may change after seeing DEV.

If FRESH has too few trades for a stable comparison, classification must acknowledge `INSUFFICIENT_DATA`.

## Classification (frozen)

Evaluate **after-cost** baseline (0 extra slippage, no invented financing). Prefer FRESH when FRESH has ≥ 30 trades on **both** versions; otherwise use full sample and downgrade confidence.

Do **not** call POC helpful from win rate alone.

| Label | Meaning |
|---|---|
| `POC_HELPFUL` | B improves trade **quality** after costs on the evaluation window: higher expectancy R **and** profit factor, not destroyed by drawdown, and the quality lift is visible on FRESH if FRESH is large enough. Frequency reduction is disclosed and is not by itself disqualifying. |
| `POC_NEUTRAL` | Differences are small, mixed, or explained by fewer trades without a material quality lift. |
| `POC_HARMFUL` | B is worse on expectancy R and/or PF after costs, or POC removes the better side of the distribution. |
| `INSUFFICIENT_DATA` | Too few trades (especially FRESH or per-direction) to support a causal claim. |
| `IMPLEMENTATION_FAILED` | Causality/lookahead failure, data failure, or A/B isolation broken. |

Research-candidate recommendation (A / B / BOTH / NEITHER) is separate from the POC label. A losing base is allowed to remain a research candidate only if the evidence is still useful; **do not deploy**.

## Out of scope

- EMA length, slope lookback, stop offset, RR, hold, spread threshold, sessions, ADX, alternate POC definitions, bin counts, day-boundary experiments, grid search, ML.
