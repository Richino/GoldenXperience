# POST_SIGNAL_MICRO_CONFIRMATION_V1 — Data audit (resolution)

This audit runs **before any modelling**, because the whole experiment hinges on
the resolution of post-signal price data. Per the brief, no sub-minute data is
fabricated; where it is missing that is stated plainly.

## Finest price resolution available locally

| Timeframe | Present? | Notes |
|---|---|---|
| Tick / trade prints | **NO** | none in the repo |
| 1-second (S1) | **NO** | none |
| 5/10/15/30-second (S5–S30) | **NO** | none |
| 1-minute (M1) | **NO** | none |
| **5-minute (M5)** | **YES — finest** | bid/ask OHLC, 300 s per bar |
| M15 / H1 / H4 | YES | coarser |

Confirmed programmatically: the smallest bar spacing anywhere in the caches is
**300 seconds**. Candle files exist only at suffixes `_M5, _M15, _H1, _H4`.

## M5 coverage (the finest lane)

| Pair | Rows | From | To | Min spacing |
|---|---:|---|---|---:|
| EUR_USD | 223,753 | 2023-08-28 | 2026-08-27 | 300 s |
| GBP_USD | 223,669 | 2023-08-28 | 2026-08-27 | 300 s |
| USD_JPY | 223,669 | 2023-08-28 | 2026-08-27 | 300 s |

M5 exists for **only these three pairs**. No M5 for USD_CHF, USD_CAD, AUD_USD,
EUR_GBP, EUR_JPY, XAU_USD (they exist only at M15+).

## Consequence for the requested observation windows

The brief asks to observe the path over **30, 60, 120, 180, 300 seconds** after a
signal, ideally sampling every 1 s.

| Requested window | vs one 300 s M5 bar | Observable historically? |
|---|---|---|
| 30 s | 1/10 of a bar | **No** — sub-bar, zero samples |
| 60 s | 1/5 of a bar | **No** — sub-bar |
| 120 s | 2/5 of a bar | **No** — sub-bar |
| 180 s | 3/5 of a bar | **No** — sub-bar |
| 300 s | exactly one bar | Only one OHLC point — **no path** (no crossings, velocity, HH/HL sequence, breakout/acceptance dynamics) |

**Therefore the true second-level micro-confirmation experiment cannot be
validated on local data.** Not even approximately: the *shortest* requested
window (30 s) is one-tenth of a single available bar, and the entire premise —
counting entry crossings, HH/HL/LH/LL, velocity/acceleration, breakout-and-
acceptance within 30–300 s — requires intra-window sampling the data does not
contain.

## Verdict on the core question

**`INSUFFICIENT_HIGH_RESOLUTION_DATA`** for the experiment as specified. The
historical result cannot validate true 1-second (or even 1-minute) post-signal
confirmation. This is a data-availability limit, not a modelling choice.

## Highest legitimate resolution available → the M5 "minute-scale proxy"

The only honest historical study possible is a **coarse minute-scale analog**:
treat each subsequent **M5 bar** as one observation step and test post-signal
"confirmation windows" of **1–6 M5 bars (5–30 minutes)**. This tests the same
*hypothesis* ("does price behaviour after the signal, before entry, carry
incremental information?") at a ~100× coarser timescale. It is **indicative
only** and explicitly cannot stand in for 1-second confirmation.

The `MICRO_FEATURES.md` architecture is written to be **resolution-parameterised**
(a `stepSeconds` knob): it runs on M5 today and can consume 1 s / tick data
unchanged if such a feed is added later — satisfying "keep the architecture
capable of consuming 1-second live data."
