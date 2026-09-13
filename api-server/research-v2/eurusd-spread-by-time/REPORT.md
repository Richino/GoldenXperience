# EUR/USD Execution-Cost Study — Spread by Time of Day (ET)

**Research only. No trading strategy created, modified, or activated.** This phase measures execution cost (bid/ask spread) only.

## Data

| | Primary | Corroborating |
|---|---|---|
| File | `backtest-breakout-m5/candles/EUR_USD_M5.json` | `api-server/research-v2/four-family-v2-201-trades/cache/EUR_USD-M1.json` |
| Source | OANDA M5 BID/ASK | OANDA M1 BID/ASK |
| Granularity | M5 | **M1 (finest)** |
| Coverage | 2023-08-28 → 2026-08-27 (~3 yr) | 2026-08-16 → 2026-09-05 (~3 wk) |
| Observations | **223,753** | 21,426 |

The finest data in the project (true M1) covers only ~3 weeks — too thin to fill a 24×7 = 168-bucket hour×day grid reliably. So the **3-year M5 BID/ASK set is the primary source** (finest granularity that is *also* statistically robust per bucket, ~9,300 obs/hour), and the **M1 set is used as a recent corroborating snapshot**. Both agree on the shape (see below).

**Spread definition:** `askClose − bidClose` per bar, in pips (1 pip = 0.0001). One clean point-in-time sample per bar. Saturdays excluded (market closed); spreads > 50 pip dropped as data errors. All times converted to **US Eastern (America/New_York)** with correct **EST/EDT** switching via IANA tz (per-timestamp), shown in 12-hour AM/PM.

## Headline table (ranked cheapest → most expensive, ET)

| TIME (ET) | AVG SPREAD | MEDIAN | P90 | STABILITY | SAMPLE SIZE | VERDICT |
|---|---|---|---|---|---|---|
| 11 AM | 1.54 | 1.50 | 1.70 | Rock-solid (cv 0.08, spk 0.2%) | 9324 | BEST — cheap & stable |
| 12 PM | 1.54 | 1.50 | 1.70 | Rock-solid (cv 0.07, spk 0.2%) | 9324 | BEST — cheap & stable |
| 1 PM | 1.54 | 1.50 | 1.70 | Rock-solid (cv 0.07, spk 0.2%) | 9324 | BEST — cheap & stable |
| 7 AM | 1.55 | 1.50 | 1.70 | Rock-solid (cv 0.07, spk 0.2%) | 9324 | BEST — cheap & stable |
| 6 AM | 1.55 | 1.50 | 1.70 | Rock-solid (cv 0.07, spk 0.2%) | 9324 | BEST — cheap & stable |
| 5 AM | 1.55 | 1.50 | 1.70 | Rock-solid (cv 0.08, spk 0.3%) | 9324 | BEST — cheap & stable |
| 4 AM | 1.56 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.3%) | 9324 | Good |
| 2 PM | 1.56 | 1.50 | 1.70 | Stable (cv 0.13, spk 0.7%) | 9324 | Good |
| 9 AM | 1.56 | 1.50 | 1.70 | Stable (cv 0.10, spk 0.6%) | 9324 | Good |
| 3 PM | 1.56 | 1.50 | 1.70 | Stable (cv 0.14, spk 0.6%) | 9323 | Good |
| 10 AM | 1.56 | 1.50 | 1.70 | Choppy (cv 0.11, spk 1.1%) | 9324 | Good |
| 2 AM | 1.56 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.2%) | 9324 | Good |
| 3 AM | 1.57 | 1.60 | 1.70 | Stable (cv 0.09, spk 0.5%) | 9324 | Good |
| 1 AM | 1.57 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.2%) | 9324 | Good |
| 12 AM | 1.57 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.3%) | 9324 | Good |
| 11 PM | 1.57 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.2%) | 9324 | Good |
| 10 PM | 1.57 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.3%) | 9324 | Good |
| 9 PM | 1.58 | 1.60 | 1.70 | Rock-solid (cv 0.08, spk 0.2%) | 9324 | Good |
| 8 PM | 1.58 | 1.60 | 1.70 | Rock-solid (cv 0.09, spk 0.3%) | 9324 | Good |
| 8 AM | 1.60 | 1.60 | 1.70 | Choppy (cv 0.22, spk 2.8%) | 9324 | Caution — news spikes |
| 7 PM | 1.60 | 1.60 | 1.80 | Stable (cv 0.12, spk 0.6%) | 9324 | OK |
| 4 PM | 1.61 | 1.60 | 1.80 | Choppy (cv 0.28, spk 1.5%) | 9323 | OK |
| 6 PM | 1.84 | 1.70 | 2.10 | Volatile (cv 0.40, spk 11.4%) | 9324 | AVOID — frequent spikes |
| 5 PM | 3.66 | 3.10 | 6.30 | Volatile (cv 0.52, spk 86.4%) | 9303 | AVOID — rollover spike |

*STABILITY* = coefficient of variation (cv = σ/mean) + spike rate (share of bars with spread > 2.0 pip). A low average with a high cv/spike rate is **not** cheap in practice.

## Cheapest windows (obs-weighted, continuous, circular over 24 ET hours)

| Window | Time (ET) | Avg spread | Worst-hour P90 | Obs |
|---|---|---|---|---|
| **Cheapest 1-hour** | **11 AM – 12 PM** | 1.540 | 1.70 | 9,324 |
| **Cheapest 2-hour** | **11 AM – 1 PM** | 1.540 | 1.70 | 18,648 |
| **Cheapest 3-hour** | **11 AM – 2 PM** | 1.541 | 1.70 | 27,972 |

Runner-up 3-hour windows: 10 AM–1 PM (1.547), 12 PM–3 PM (1.547), 5 AM–8 AM (1.551), 9 AM–12 PM (1.552) — all within ~0.01 pip.

## Most *consistently* cheap (low average AND low variance/spikes)

Composite score (0.45·avg + 0.35·P90 + 0.20·cv, all normalized, lower = better):

1. **12 PM ET** — avg 1.541, P90 1.70, cv 0.07, spike 0.2%
2. **1 PM ET** — avg 1.544, P90 1.70, cv 0.07, spike 0.2%
3. **6 AM ET** — avg 1.550, P90 1.70, cv 0.07, spike 0.2%
4. **7 AM ET** — avg 1.549, P90 1.70, cv 0.07, spike 0.2%
5. **11 AM ET** — avg 1.540, P90 1.70, cv 0.08, spike 0.2%

The **11 AM – 1 PM ET** band is simultaneously the cheapest *and* the most stable — the ideal combination.

## Hours to AVOID (spreads frequently spike)

| Time (ET) | Avg | P90 | Max | Spike rate (>2 pip) | Note |
|---|---|---|---|---|---|
| **5 PM** | 3.66 | 6.30 | 10.0 | **86.4%** | 21:00 UTC daily rollover — spread ~2.4× normal, almost always. **Hard avoid.** |
| **6 PM** | 1.84 | 2.10 | 10.0 | 11.4% | Post-rollover thin liquidity tail. |
| **8 AM** | 1.60 | 1.70 | 10.0 | 2.8% | US data releases (8:30 AM ET) — median is fine but tails blow out. Avoid the release minute, not the whole hour. |
| **4 PM** | 1.61 | 1.80 | 10.0 | 1.5% | Approaching rollover; liquidity thinning. |

## Day-of-week (ET)

| Day | Avg | Median | P90 | Obs |
|---|---|---|---|---|
| Sun | **2.05** | 1.60 | 3.50 | 12,783 |
| Mon | 1.65 | 1.60 | 1.70 | 44,798 |
| Tue | 1.65 | 1.60 | 1.70 | 45,047 |
| Wed | 1.65 | 1.60 | 1.70 | 44,628 |
| Thu | 1.65 | 1.60 | 1.70 | 44,517 |
| Fri | **1.60** | 1.60 | 1.70 | 31,980 |

**Sunday** (post-open, first hours of the week) is the worst day — wide and unstable. Mon–Thu are flat; Friday is marginally the tightest weekday. Full hour×day-of-week detail is in `hour_dayofweek_et_M5_3yr.csv`.

## Does the London/NY overlap win? — No, prove it from the data

The classic London/NY overlap is **8 AM – 12 PM ET**. The data says:

- The overlap band is *good* but **not the cheapest**, and its **opening hour (8 AM ET) is one of the worst** for spikes (cv 0.22, 2.8% spike rate) because of the 8:30 AM ET US data window.
- The genuine minimum sits **later**, in the **late-morning-to-early-afternoon London/NY tail: 11 AM – 1 PM ET**, where liquidity is deep *and* the news window has passed — cheapest average **and** lowest variance.
- Cost is remarkably flat (~1.54–1.58 pip) across the whole **5 AM – 3 PM ET** European+US session; the real decision is avoiding the **5 PM ET rollover** (and to a lesser degree 6 PM and the 8:30 AM news minute), not chasing the "overlap."

The M1 3-week snapshot independently reproduces this: cheapest cluster in the 5 AM–2 PM ET session, and 5 PM ET catastrophic (avg 3.55 pip, 89% spike rate).

---

## FINAL RECOMMENDATION

**BEST EURUSD LOW-COST TRADING WINDOW: 11 AM – 1 PM ET** (≈ 15:00–17:00 UTC / 16:00–18:00 London), avg spread **1.54 pip**, P90 **1.70 pip**, cv 0.07, spike rate 0.2%.

Acceptable low-cost band overall: **5 AM – 3 PM ET**, all ≤ ~1.56 pip and stable. **Hard-avoid 5 PM ET** (daily rollover, ~3.7 pip / 86% spike) and be cautious at **6 PM ET** and around the **8:30 AM ET** US-data minute.

## Files

- `REPORT.md` — this report
- `SUMMARY.json` — machine-readable summary
- `hourly_et_M5_3yr.csv` — per-hour stats (primary, 3-yr M5)
- `hourly_et_M1_3wk.csv` — per-hour stats (corroborating, M1)
- `ranked_hours_et_M5_3yr.csv` — hours ranked cheap→expensive
- `dayofweek_et_M5_3yr.csv` — per day-of-week
- `hour_dayofweek_et_M5_3yr.csv` — full hour × day-of-week grid
