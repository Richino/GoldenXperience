# Implementation Notes — binary-double-bollinger-1m-v1

Isolation, interpretation choices, and every ambiguity resolved. This experiment
imports nothing from `src/`, writes only inside this directory, and touches no
database or live/adaptive/binary engine.

## Files

- `fetch.mjs` — pulls M1 mid OHLC for the 12 pairs from OANDA, pages backward
  ~19 calendar days, caches raw candles to a JSON the runner reads. Re-runnable.
- `run.mjs` — self-contained indicator + signal + settlement + aggregation
  engine. Emits all report artifacts.
- Outputs: `FINAL_REPORT.md`, `RESULTS.json`, `TRADES.csv`, `PAIR_RESULTS.csv`,
  `VARIANT_RESULTS.csv`, `DAILY_RESULTS.csv`.

The raw candle cache lives in the session scratchpad (not committed) to avoid
bloating the repo; the exact fetch window is recorded in `RESULTS.json → meta`.

## Data & pairs

- Universe = the project's `STREAM_INSTRUMENTS` (exactly 12 pairs). No synthetic
  substitution; if OANDA returned nothing the run would have failed loudly.
- Price = OANDA `price=M` mid OHLC. Entry/expiry use this mid, matching the
  strategy's "actual market price" settlement requirement.
- **12 complete trading days** = the last 12 UTC calendar dates whose max
  per-pair M1 count ≥ 1000 (filters out the partial lead-in day). Result:
  2026-08-13 … 2026-08-28. The same date set is applied to all pairs.

## Candle type

- Heikin Ashi computed from market OHLC: `HAclose=(o+h+l+c)/4`,
  `HAopen=(prevHAopen+prevHAclose)/2` (seed `(o₀+c₀)/2`), bull if `HAclose≥HAopen`.
- **HA is used only for the HA-rejection confirmation.** All band/oscillator math
  and all settlement use the real market OHLC. This follows the brief's literal
  wording ("*Actual* candle high ≥ upper BB", "settlement uses the actual market
  price, NOT the synthetic Heikin Ashi close").

## Indicators (frozen — not swept)

- **Bollinger** (20, 2) and (20, 3): population standard deviation, matching the
  project's `computeBollinger` in `src/pattern-v1.ts`. Computed on market close.
- **Stochastic (6,3,3)**: fast %K over 6 (`100·(c−LL)/(HH−LL)`), slow %K =
  SMA(fastK,3), %D = SMA(slowK,3). Cross uses slow %K vs %D.
- **CCI(21)**: typical price `(h+l+c)/3`, SMA(21), mean absolute deviation,
  `CCI=(TP−SMA)/(0.015·MAD)`. Slope = `CCI[i]−CCI[i−1]`.
- **ADX/DMI** — see the interpretation section below.

## BB event definitions (per candle `i`; DOWN uses upper band, UP mirrors on lower)

- **BB2 touch**: `high ≥ upperBB2` (DOWN) / `low ≤ lowerBB2` (UP).
- **BB3 approach / "between BB2–BB3"**: touched BB2 but not BB3.
- **BB3 touch**: `high ≥ upperBB3` / `low ≤ lowerBB3`.
- **BB2 rejection** (variant A base): `high ≥ upperBB2 AND close < upperBB2`
  (mirror for UP). Single-candle poke-and-close-back.
- **BB3 rejection** (variant B): `high ≥ upperBB3 AND close < upperBB3`.
- Generic "BB rejection" used as the base for variants C–I = **BB2 rejection**
  (the broader, higher-sample event). Documented so the confirmation comparisons
  share one base.

### Why "BB3 touch (no rejection)" is empty

The extension analysis is computed over the rejection-based candidate set
(variants A ∪ B). A candle that pierced the 3σ band but *closed beyond it* would
be a BB3 touch without rejection — but on M1 that essentially never happens
(3σ pokes are wicks that close back inside), and such a candle also fails the
BB2-rejection test (its close is above BB2), so it is absent from the set. The
cell is therefore definitionally empty, not a data error.

## Confirmations (DOWN; UP mirrors)

- **Heikin Ashi rejection**: `HA[i−1]` bullish AND `HA[i]` bearish.
- **Stochastic**: slow %K crosses below %D: `K[i−1] ≥ D[i−1] AND K[i] < D[i]`.
- **CCI**: falling — `CCI[i] < CCI[i−1]`.
- **ADX**: convergence→divergence rule below.

## ADX "periods 1 and 5" — interpretation (labeled, defensible)

The source says "ADX as periods 1 and 5" and describes "+DI, −DI and ADX
converge/touch then sharply diverge." Both are ambiguous, so the most defensible
deterministic reconstruction was chosen and is labeled as an interpretation:

- **Periods 1 and 5** → 1-bar directional movement (standard DMI always uses the
  1-bar `+DM/−DM`), with **5-period Wilder smoothing** of ATR/DM and a 5-period
  Wilder smoothing of DX into ADX. This mirrors the project's `computeAdx14`
  (`src/pattern-v1.ts`) with the period changed from 14 to 5.
- **Converge → diverge**, made numeric (frozen constants, not swept):
  - *Convergence*: the DI lines "touched" — `|+DI − −DI| ≤ 6` at some bar within
    the last 3 bars (`ADX_CONV=6`, `ADX_LOOK=3`).
  - *Divergence (DOWN)*: `−DI > +DI` AND the gap widened vs the prior bar
    (`(−DI−+DI)ᵢ > (−DI−+DI)ᵢ₋₁`) AND ADX rising (`ADXᵢ > ADXᵢ₋₁`). UP mirrors
    with `+DI`.

This is the single primary ADX interpretation used in variants F and I. It is
intentionally strict (hence only ~99 fires), matching the "sharp divergence after
a touch" description. Results are labeled so a different reading can be compared
later; ADX was the most damaging component, so a looser reading is unlikely to
rescue the method.

## Entry / expiry / settlement

- Signal recognized on completed candle `i`. **Entry = `open[i+1]`** (next
  available market price after confirmation). **Expiry = `close[i+1]`**, exactly
  60s later. DOWN win if `expiry < entry`; UP win if `expiry > entry`; exact
  equality = TIE (never counted as a win; reported separately).
- `WR = Wins / (Wins + Losses)`, ties excluded from the denominator.
- Settlement requires the next minute to be contiguous (`Δt == 60s`); signals at
  session/weekend edges are skipped.

## Sessions (UTC hour of entry)

Asia 21:00–06:59 · London 07:00–11:59 · London/NY overlap 12:00–15:59 ·
New York 16:00–20:59. Buckets are reported alongside per-hour and per-day tables.

## Statistics

- 95% CI = Wilson score interval on (wins, wins+losses).
- Break-even `WR = 1/(1+payout)`; expectancy `EV = WR·payout − (1−WR)` per $1
  risked, at payouts 0.70/0.75/0.80/0.85/0.90. Hypothetical payout modeling only —
  no assumption that this historical data represents executable broker fills.
- Subgroups are flagged `INSUFFICIENT_SAMPLE` in the report where n is too small
  (the full method per-pair, ADX-gated variants, |CCI|>200 zone).

## Non-optimization

Indicator parameters are frozen at the requested values. The only alternatives
compared are the explicitly-requested ambiguous items (stochastic and CCI neutral
zones, ADX interpretation), each clearly labeled as an interpretation test. No
parameter was tuned toward a better 12-day result.
