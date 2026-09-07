# POC SPEC — yesterday UTC-day volume-profile approximation

**Experiment ID:** `eurusd-h1-ema-pullback-poc-ab-v1`  
**Frozen before results.** Do not retune bins, day boundaries, or assignment rules after seeing P&L.

This is **not** a centralized-exchange volume profile. Spot EURUSD has no single-exchange contract volume. OANDA `volume` is **tick / activity volume** (number of price changes contributing to the candle), not global transacted notional.

## Existing GoldenXperience POC implementations

Repository search (`POC`, `computePoc`, `pocBins`, volume bins, previous-day POC):

| Path | What it computes | Match to this experiment? |
|---|---|---|
| `frontend/scripts/usdjpy-poc-swing-long.ts` `computePoc` | 24 equal-width bins over the **previous 24 completed H1 bars**. HLC3 of each bar; entire tick volume assigned to that bin; POC = **center** of the highest-volume bin; volume ties → **lowest-price** bin; clamp `price == rangeHigh` into the last bin. Tested in `frontend/scripts/test-usdjpy-poc-swing-long.ts`. | **Math matches.** Window does **not**: it is a rolling 24-H1 lookback, not a frozen previous UTC calendar day. |
| `api-server/research-v2/usdjpy-poc-swing-long-v1-validation/PINE_RULE_SPEC.md` | Documents the same 24-bin H1 approximation. | Same. |
| Other `POC` hits | Unrelated (pockets, binary, etc.). | No. |

**Choice:** reuse the **HLC3 / equal-width bins / full-bar volume / bin-center / lowest-bin-on-tie** methodology from `computePoc`. Apply it to **previous completed UTC calendar day M5 bars** with **48 bins**, as specified for this A/B test. Do not use the rolling 24-H1 window, because that would test a different filter than “yesterday’s POC.”

Bins are **not** compared 24 vs 48 vs 100 after results. 48 is frozen.

## Source data

- Same OANDA MBA feed as the strategy.
- Timeframe: **M5 completed candles**.
- Price for range and HLC3: **mid** OHLC (same as the USDJPY `computePoc` input).
- Volume field: OANDA candle `volume` (tick/activity count).

## Day boundary (causal, no repaint)

UTC calendar day `D` (example `2026-09-05`) uses **only** M5 bars whose **open time** `t` satisfies:

```
2026-09-04T00:00:00.000Z  <=  t  <  2026-09-05T00:00:00.000Z
```

That window is computed once and **frozen** at UTC midnight. Every H1 signal whose signal-bar open falls on UTC day `D` reads the same POC from day `D-1`. Current-day M5 data never enters today’s POC.

Monday signals use Sunday’s UTC day if Sunday M5 exists; if the previous UTC day has no M5 bars (typical Saturday), walk back to the last UTC day that has M5 data? **No.** Spec is the previous completed UTC calendar day only. If that day has no bars (Saturday), POC is **unavailable** (`POC_UNAVAILABLE`). Sunday/Monday therefore use Friday only when Friday **is** the previous UTC date (Sunday signals → Saturday POC unavailable; Monday signals → Sunday POC, which usually has the Sunday open session).

This is intentional and documented. We will not silently substitute “last session day” after seeing results.

## Algorithm (frozen)

Let `bars` be completed M5 mid bars in the previous UTC day.

```
rangeLow  = min(low of bars)
rangeHigh = max(high of bars)
bins      = 48
```

If `bars` is empty or `rangeHigh - rangeLow <= 0`, POC is null.

```
binSize = (rangeHigh - rangeLow) / 48
volumes[0..47] = 0

for each bar:
  hlc3 = (high + low + close) / 3
  bin  = floor((hlc3 - rangeLow) / binSize)
  clamp bin to [0, 47]
  volumes[bin] += bar.volume   # entire M5 tick volume

maxBin = first index of max(volumes)   # lowest-price bin on ties
POC    = rangeLow + binSize * (maxBin + 0.5)
```

POC is the **center** of the densest bin.

## Filter application (Version B only)

Preferred signal price: completed H1 **mid close**.

```
LONG  allowed iff signalClose > POC
SHORT allowed iff signalClose < POC
```

Equality is **not** allowed (`<=` / `>=` are blocked). Log `BLOCKED_BY_POC`.

## What this POC is not

- Not CME/futures volume.
- Not a broker’s hidden order book.
- Not a rolling intraday profile.
- Not Value Area, VAH, VAL, or HVN/LVN besides the single POC price.
