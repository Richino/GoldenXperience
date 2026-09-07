# GX POC SWING LONG ONLY V1 — Pine rule spec

**Strategy:** GX POC SWING LONG ONLY V1  
**Instrument:** OANDA USD_JPY / USDJPY  
**Direction:** LONG only  
**Status:** Frozen validation spec. Do not retune.

## Source of this document

The user named the TradingView Pine script **GX POC SWING LONG ONLY V1** as the source of truth and asked for a line-by-line translation before any backtest.

The `.pine` file was **not present** in the GoldenXperience workspace, agent attachments, or local searches (`**/*.{pine,pinescript}`, `GX POC SWING`, `lockedPOC`). This document therefore translates the **user-supplied Pine behavior**, which was written as an explicit rule-by-rule description of that script.

If the original `.pine` file later disagrees with this spec, **the Pine file wins** and this validation must be re-run. Until then, every implementation choice below follows the supplied Pine description, not a redesigned swing model.

Where the description still leaves a mechanical detail unspecified, the choice is labeled **PINESPEC AMBIGUITY** and the implementation uses ordinary Pine v5/v6 behavior (`ta.highest`/`ta.lowest` on `high[1]`/`low[1]`, `request.security(..., close[1])` with `lookahead_off`, first-max bin on volume ties).

---

## 1. Timeframe

- Primary / entry chart: **H1** (60-minute OANDA candles).
- This is a **swing** strategy. Do not convert it to M15 or any session-based day-trade model.
- No London filter, no New York filter, no 23:00–05:00 filter, no weekday filter, no session box.

**Pseudocode**

```
timeframe = H1
evaluate once per completed H1 bar
```

## 2. Higher-timeframe handling

- Higher timeframe: **H4**.
- Bias filter: **ON**.
- H4 fast EMA length: **50**.
- H4 slow EMA length: **200**.
- Pine uses **previously completed** H4 data, conceptually:

```
h4Close   = H4 close[1]
h4Ema50   = H4 EMA50[1]
h4Ema200  = H4 EMA200[1]
```

Equivalent confirmed-HTF behavior: on each H1 bar, find the H4 bar that has **already started** at or before this H1 open (`lastIndexAtOrBefore`). That H4 bar is the *currently forming* H4. Use the **previous** H4 index (`startedIndex - 1`) for close and both EMAs.

Do **not** use the in-progress H4 close or EMA. Do **not** write the final H4 close of a still-open H4 back into earlier H1 bars.

LONG H4 bias is true only when both:

```
previousCompletedH4.close  > previousCompletedH4.ema50
previousCompletedH4.ema50  > previousCompletedH4.ema200
```

H4 EMAs are computed on the H4 close series only, then read at the previous-completed index. That is causal.

**Pseudocode**

```
startedH4 = lastIndexAtOrBefore(h4OpenTimes, h1OpenTime)
completedH4 = startedH4 - 1
if completedH4 < emaSlowWarmup: h4Bull = false
else:
  h4Bull = h4Close[completedH4] > h4Ema50[completedH4]
       AND h4Ema50[completedH4] > h4Ema200[completedH4]
```

## 3. ATR calculation

- Length: **14**.
- Method: Wilder / Pine `ta.atr(14)` (RMA of true range). Seed is the mean of the first 14 true ranges, then `ATR = (ATR[1] * 13 + TR) / 14`.
- Series: **H1 midpoint** OHLC.

Uses:

| Quantity | ATR bar |
|---|---|
| Consolidation width cap | `ATR[1]` (previous completed H1 ATR) |
| Breakout body minimum | current H1 ATR |
| Breakout distance beyond range high | current H1 ATR |
| POC retest tolerance | current H1 ATR |
| Stop / target at signal | current H1 ATR on the **signal** bar |

Do not recompute stop distance from a later bar’s ATR.

**Pseudocode**

```
atr = ta.atr(14)            // current H1 bar
prevAtr = atr[1]
riskDistance = atr * 1.5    // only on the signal bar
```

## 4. Consolidation calculation

On every H1 bar `i`, the **current** bar is excluded.

```
lookback = 24
rangeHigh = highest high of H1 bars [i-24, i-1]
rangeLow  = lowest low  of H1 bars [i-24, i-1]
rangeWidth = rangeHigh - rangeLow
inConsolidation = rangeWidth <= prevAtr * 4.0
```

This is the Pine equivalent of `ta.highest(high[1], 24)` / `ta.lowest(low[1], 24)`.

The breakout candle must **not** be inside that 24-bar window.

If `prevAtr` is missing or `<= 0`, consolidation is false.

## 5. POC calculation

This is **not** an exchange volume-profile POC. It is the Pine 24-bin HLC3 approximation.

On H1 bar `i`, using the same previous-24 window and the same `rangeLow`/`rangeHigh`:

```
pocBins = 24
binSize = (rangeHigh - rangeLow) / 24
```

If `rangeWidth <= 0`, POC does not exist.

For each of the previous 24 H1 bars:

```
price = HLC3 = (high + low + close) / 3
assign the ENTIRE bar volume to the bin containing price
```

**Volume field:** OANDA FX candles expose **tick volume** (`volume` on the MBA candle). There is no centralized exchange contract volume for spot USDJPY. Do not substitute futures or broker-book volume.

**PINESPEC AMBIGUITY — bin edges.** Pine `math.floor((price - rangeLow) / binSize)` returns `24` when `price == rangeHigh`. Clamp to `[0, 23]` so the top tick stays in the last bin.

**PINESPEC AMBIGUITY — volume ties.** If several bins share the maximum accumulated volume, take the **first** (lowest-price) bin. That matches a left-to-right `array.max` / first-index scan.

```
POC = rangeLow + binSize * (highestVolumeBin + 0.5)
```

POC is the **center** of that bin.

## 6. Breakout detection

Current H1 body:

```
body = abs(close - open)
strongBody = body >= atr * 0.25
```

Bullish breakout / displacement is true when **all** of:

1. `inConsolidation`
2. `strongBody`
3. `close > rangeHigh + atr * 0.10`
4. confirmed H4 bullish bias is true
5. POC exists (finite)

No short breakout is evaluated.

## 7. Setup creation

When a bullish breakout is true, freeze a LONG setup on that H1 bar:

```
lockedPOC       = POC calculated on this bar from the previous 24 bars
lockedRangeHigh = rangeHigh
lockedRangeLow  = rangeLow
breakoutBar     = current H1 index
breakoutTime    = current H1 open time
```

A new qualifying breakout **replaces** any existing setup. After replacement, `barsSinceBreakout = 0`, so the strategy cannot enter on that same bar.

Do **not** keep recalculating POC after the breakout. Retest uses `lockedPOC` only.

## 8. Setup expiration

```
barsSinceBreakout = currentH1Index - breakoutBar
expired = barsSinceBreakout > 48
```

Match Pine `>` exactly. At `barsSinceBreakout == 48` the setup is still valid. At `49` it is deleted.

Evaluation order on each bar (Pine sequential `:=`):

1. Expire if `barsSinceBreakout > 48`
2. Invalidate (section 9)
3. Possibly create / replace on a new breakout
4. Evaluate retest / entry on the resulting setup

## 9. Setup invalidation

A LONG setup is invalid when:

```
H1 close < lockedRangeLow
```

This uses **close**, not low. A wick through `lockedRangeLow` does not invalidate.

On invalidation, delete the setup.

## 10. POC retest

```
pocTolerance = currentH1Atr * 0.25
retest = low <= lockedPOC + pocTolerance
     AND high >= lockedPOC - pocTolerance
```

The candle range must intersect the POC tolerance zone. The close does **not** have to touch POC.

## 11. Confirmation candle

Directional confirmation is **ON**.

The same H1 candle that satisfies retest must also satisfy:

```
close > lockedPOC
AND close > open
```

The candle must be bullish and close above the locked POC.

## 12. Entry timing

`strategy(..., process_orders_on_close=true, calc_on_every_tick=false, pyramiding=0)`

A LONG signal requires **all** of:

- active LONG setup
- `barsSinceBreakout > 0` (cannot enter on the breakout bar)
- POC retest true
- bullish confirmation true
- confirmed H4 bullish bias **still** true
- no existing strategy position

**Entry price (midpoint / Pine parity):** the **signal H1 midpoint close**.  
That is the `process_orders_on_close=true` fill.

**Executable overlay (not Pine):** long entry at that bar’s **ask close**. Stop and target are rebuilt from the **frozen signal-bar ATR** around that executable entry. They are not rebuilt from a later ATR.

## 13. Stop calculation

On the signal bar only:

```
riskDistance = currentH1Atr * 1.5
longStop     = signalClose - riskDistance
```

No trail, no breakeven, no stop based on `lockedRangeLow`.

## 14. Target calculation

```
rewardRisk   = 2.0
longTarget   = signalClose + riskDistance * 2.0
```

Equivalent target distance is `3.0 * ATR` from the signal close.

No scale-out, no partial exits, no time stop.

## 15. Position / state handling

- LONG only. No shorts.
- Pyramiding = 0. One open trade at a time.
- After a LONG entry fires, **clear** the active setup.
- While a position is open, do not open another position.
- New breakouts may still replace setup state while a trade is open; that setup can only fire after the position is flat.
- Occupancy: a new signal is ignored while `decisionTime <= occupiedUntil` (exit timestamp of the open trade). Same-bar re-entry after an SL/TP fill is **not** taken.

**PINESPEC AMBIGUITY — same-bar reverse.** Pine can theoretically `strategy.exit` and `strategy.entry` on the same `process_orders_on_close` bar. This validation forbids that (occupancy uses `<=`) so pyramiding stays 0 without an implicit reverse.

Exit simulation:

- No max-hold time exit.
- After the signal bar, inspect subsequent H1 bars.
- LONG stop if `low <= stop`; LONG target if `high >= target`.
- If both can fill in one bar and no lower-timeframe path exists: **stop first** (conservative).
- Adverse stop gap: fill at `min(stop, bar.open)` on midpoint, or the worse executable open on bid/ask.
- Target gaps are not improved.

## 16. Pine-specific behavior that affects parity

1. **Confirmed HTF only.** `request.security` with `close[1]` / `ema[1]` and `lookahead_off` is `startedH4Index - 1`, never the forming H4.
2. **Consolidation window is `[1]` not `[0]`.** Including the breakout bar in `ta.highest(high, 24)` would be a different strategy.
3. **Two different ATRs.** Width uses `ATR[1]`; displacement, body, tolerance, and stop use current ATR.
4. **`process_orders_on_close=true`.** Entry is the signal-bar close, not the next open.
5. **`calc_on_every_tick=false`.** No intrabar setup creation. All logic is bar-close.
6. **Expiration is `>` 48, not `>=` 48.**
7. **Entry requires `barsSinceBreakout > 0`.** Breakout bar cannot be the entry bar.
8. **Invalidation is close-based.**
9. **Volume is tick volume.** TradingView OANDA volume and OANDA API `volume` can still differ slightly by feed.
10. **Mid vs bid candles.** TradingView USDJPY H1 is typically a mid/last feed. OANDA research candles here are midpoint OHLC plus separate bid/ask. Parity uses midpoint.
11. **H1 timestamp boundaries.** OANDA H1 opens are UTC. TradingView chart timezone can shift displayed labels without changing the bar. Compare UTC open times, not chart labels.
12. **Weekend gaps.** H1 bars are missing over the weekend; `barsSinceBreakout` counts H1 **bars**, not elapsed hours.
13. **No commission in the TradingView export.** Parity is zero-cost midpoint. Costs are a later overlay.
14. **Intrabar SL vs TP.** TradingView’s path-dependent fill can differ from stop-first. Report ambiguous bars; do not silently take the target.

---

## Frozen parameters (do not change)

| Parameter | Value |
|---|---|
| Entry TF | H1 |
| HTF | H4 |
| ATR length | 14 |
| Consolidation lookback | 24 H1 bars (current excluded) |
| Max consolidation width | 4.0 ATR |
| POC bins | 24 |
| POC retest tolerance | 0.25 ATR |
| Min breakout distance | 0.10 ATR |
| Min breakout body | 0.25 ATR |
| Max retest wait | expire when `barsSince > 48` |
| Directional confirmation | ON |
| H4 EMA fast / slow | 50 / 200 |
| H4 bias filter | ON |
| Stop | 1.5 ATR |
| Reward:risk | 2.0R |

## Explicitly out of scope

- The earlier USDJPY **15-minute** POC / body-extreme model
- Any 23:00–05:00 short filter
- 1.0 ATR stops, M15 setups, session boxes
- Parameter search of any kind
- Production strategy registration or deployment
