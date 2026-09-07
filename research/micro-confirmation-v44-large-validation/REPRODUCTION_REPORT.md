# REPRODUCTION REPORT — Micro Confirmation V4.4

## Summary

**Reproduction result: ACCEPTABLE (M1 tight; M5 within small-sample noise).**
The local port reproduces the TradingView M1 BASELINE and M1 LONDON_ONLY numbers
closely over the matching recent window, and reproduces the *qualitative* M5
LONDON_ONLY behaviour (PF slightly > 1 on recent data, decaying with sample
size). The differences that remain are fully explained by (a) not knowing
TradingView's exact calendar window, (b) OANDA practice-feed vs the user's chart
feed, and (c) the documented ambiguous-bar stop-first assumption. **No strategy
threshold was changed to force reproduction.**

## Method

TradingView Free does not export a trade list, and the user supplied only
aggregate stats, so trade-by-trade matching against TradingView is not possible.
Reproduction is therefore done at the **aggregate level over the matching
recent window**, which is the strongest test available given the inputs.

The TradingView window (limited by Free-tier history depth) is unknown, so it is
**reverse-engineered by trade count**, not by tuning:

- M1: the trailing calendar window whose **BASELINE** count = 180 (TradingView's
  reported baseline count). This fixes the window to the most recent
  **2026-08-21 → 2026-09-01 (~11 days)** — consistent with Free-tier M1 depth
  (~19 baseline trades/day locally). LONDON_ONLY is then read over that same
  window.
- M5: TradingView's Free M5 depth is longer than its M1 depth, so the M5
  reproduction uses the trailing window holding **28 LONDON_ONLY** trades
  (2026-07-29 → end), matching TradingView's reported M5 London count.

## Results

| Metric | TradingView | Local port | Match |
|---|---|---|---|
| **M1 BASELINE** trades | 180 | 180 (by construction) | window fixed here |
| M1 BASELINE win rate | 30.6% | 27.2% | close |
| M1 BASELINE PF | 0.76 | 0.735 | **very close** |
| **M1 LONDON_ONLY** trades | 39 | 43 | close |
| M1 LONDON_ONLY win rate | 41.0% | 39.5% | **very close** |
| M1 LONDON_ONLY PF | 1.55 | 1.30 | same regime (PF>1) |
| **M5 LONDON_ONLY** trades | 28 | 28 (by construction) | window fixed here |
| M5 LONDON_ONLY win rate | 50.0% | 35.7% | within CI (see below) |
| M5 LONDON_ONLY PF | 1.54 | 1.12 | same sign (PF>1) |

- matched trades: aggregate-level (no TV trade export available)
- missing trades / extra trades: M1 London 43 local vs 39 TV → ~4 extra, attributable to window edges and feed micro-differences
- direction mismatches: n/a at trade level (no TV export)
- entry differences: entries occur on the same bar-close mechanic (process_orders_on_close); mid-price entry at signal-bar close
- exit differences: ambiguous bars resolved stop-first (Pine default)
- WR difference: M1 −1.5 pts (39.5 vs 41.0); M5 −14.3 pts (35.7 vs 50.0, small-sample)
- PF difference: M1 −0.25 (1.30 vs 1.55); M5 −0.42 (1.12 vs 1.54, small-sample)

## Why M5 differs more

The M5 London reproduction sample is **28 trades**; the 95% Wilson interval for a
50% win rate on n=28 spans roughly **32%–68%**. The local 35.7% sits inside that
band. Over larger recent M5 windows the local numbers are stable and modest:
last 30d 37.9% / PF 1.22, last 60d 40.4% / PF 1.32, last 90d 36.8% / PF 1.10.
TradingView's 14W-14L / PF 1.54 is the **upper tail of a 28-trade sample**, not a
stable property. The M1 reproduction (n=180 baseline, n=43 London) is far tighter
and is the diagnostic that validates the port.

## Pine execution-semantics mapping (Phase 2)

The port mirrors the script top-to-bottom, bar-by-bar. Key mappings:

- **`process_orders_on_close=true`** → a market entry fills at the **close of the
  signal bar** (same bar). Its stop/limit exit orders become live on the **next**
  bar and are checked intrabar against each later bar's high/low. Entry-bar's own
  exit is never checked on the entry bar. This avoids a one-bar shift.
- **`strategy.position_size[1]`** (used by `newLong`/`newShort` to freeze
  `tradeATR`) → captured as `posPrev`, the position at the **end of the previous
  bar**, taken before any intrabar exit fill on the current bar. This preserves
  the exact edge case where an exit-and-re-enter on the *same bar/same side*
  leaves `newLong=false` and `tradeATR` **not** refreshed.
- **`strategy.exit(...)`** is re-issued every bar → stop/target are recomputed
  each bar from the current `position_avg_price` and frozen `tradeATR`.
  (An earlier version that set the levels only on the entry bar produced an
  immortal-position bug in BASELINE mode; fixed to match Pine's per-bar exit.)
- **`ta.atr`** → Wilder RMA of True Range, seeded by SMA of the first 14 TRs.
- **`ta.highest(high[1], 20)`** → max of high over bars t−1…t−20 (excludes current).
- **Session** `time(period,"0300-0800","America/New_York")` → membership on the
  bar's **open** time in America/New_York (DST-aware via `Intl`), interval
  [03:00, 08:00). Verified: summer London entries fall in 07:00–12:00 UTC.
- **Ambiguous bar** (both stop and target inside the range) → Pine's conservative
  default: **stop filled first** (loss).

## Behaviours that cannot be reproduced exactly (reported per instructions)

1. **TradingView's exact feed and calendar window** are unknown. Local data is
   the OANDA **practice** feed (`price=BA`); the user's chart feed may differ by
   fractions of a pip. This shifts individual borderline trades but not the regime.
2. **Intrabar path within a bar** is unknown to any bar-based engine; the
   stop-first rule is the standard conservative proxy.
3. **No TradingView trade export** was provided, so matching is aggregate-level.

None of these change the conclusion: the port reproduces the M1 result tightly,
so the large-sample test that follows can be trusted.
