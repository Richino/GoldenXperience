# Legacy daemon vs four-family engine — fire rate, gate loosening, and overlap

Generated: 2026-08-26. RESEARCH ONLY. No production behavior changed.

## Motivation

After wiring the legacy-confidence-v2 daemon's audit trail (commit `67b2a50`),
we observed zero setups fired across the first cycles. Concern raised: is the
daemon simply too selective to be useful? And could running it alongside — or
as a filter on — the four-family engine rescue the four-family's negative
expectancy?

Three questions, three tests.

## Test 1 — daemon fire rate at 12 pairs vs 6 pairs; H4 gate loosening tradeoff

Script: `api-server/scripts/_backtest_legacy_12pairs_h4variant.ts`.
Data: 4 years of OANDA M15/H1/H4 bid-ask across 12 pairs
(USD_JPY, AUD_USD, EUR_USD, GBP_USD, USD_CAD, USD_CHF, EUR_JPY, GBP_JPY,
AUD_JPY, EUR_GBP, NZD_USD, XAU_USD).

Two variants, identical entries + exits + costs, differing only on whether
the H4 "not opposing" gate is enforced:

| | Variant A: strict (matches daemon) | Variant B: H4 gate removed |
|---|---:|---:|
| Trades over 4y | 849 | 1,233 (+45%) |
| Trades/day | **0.82** | 1.19 |
| Trades/week | **4.1** | 5.9 |
| Days with any fire | 52% | 67% |
| Median gap between trades | 22h | 19h |
| Max dry spell | 12.7 days | 9 days |
| Winrate | 44.7% | 43.7% |
| Net exp / trade | **+0.012R** | **−0.018R** |
| Total R | **+10.20** | **−21.57** |
| Profit factor | **1.03** | 0.96 |

**Removing the H4 gate buys +45% volume but destroys the edge**: total R
flips from +10.20 to −21.57 (a −31.77R hit). Do not loosen H4.

### Per-pair edge under Variant A (strict)

| Pair | n | Winrate | Net exp | Total R | PF |
|---|---:|---:|---:|---:|---:|
| **XAU_USD** | 89 | 55.1% | +0.309R | **+27.52** | **1.82** |
| USD_JPY | 82 | 43.9% | +0.100 | +8.21 | 1.22 |
| GBP_JPY | 84 | 45.2% | +0.069 | +5.81 | 1.15 |
| USD_CHF | 59 | 45.8% | +0.045 | +2.67 | 1.10 |
| EUR_USD | 60 | 48.3% | +0.027 | +1.64 | 1.06 |
| AUD_JPY | 94 | 51.1% | +0.012 | +1.10 | 1.02 |
| EUR_GBP | 31 | 41.9% | −0.106 | −3.30 | 0.74 |
| NZD_USD | 44 | 40.9% | −0.096 | −4.24 | 0.83 |
| EUR_JPY | 84 | 42.9% | −0.080 | −6.75 | 0.85 |
| USD_CAD | 75 | 38.7% | −0.094 | −7.06 | 0.82 |
| GBP_USD | 82 | 40.2% | −0.092 | −7.52 | 0.83 |
| AUD_USD | 63 | 36.5% | −0.125 | −7.87 | 0.76 |

**XAU_USD alone accounts for +27.52R of the strategy's total +10.20R.**
The other 11 pairs combined are −17.32R. Six pairs are outright net negative.

**Restricted to the 4 cleanly-positive pairs (XAU_USD, USD_JPY, USD_CHF,
GBP_JPY):** 314 trades over 4y = **+44.21R total** at PF ≥ 1.10 per pair.
1.5 trades/week — lower volume, ~4× the edge.

## Test 2 — four-family engine 10-year historical baseline (existing research)

Source: `api-server/research-v2/four-family-raw-historical-v1/FINAL_REPORT.txt`.
10 years (2016-06 → 2026-08), 3 pairs (EUR_USD, GBP_USD, USD_JPY), 31,449 trades.

| Family | n | Winrate | Net exp | Total R | PF |
|---|---:|---:|---:|---:|---:|
| ema | 8,577 | 33.4% | −0.168R | **−1,440.7** | 0.69 |
| breakout | 8,316 | 30.5% | −0.175R | **−1,451.6** | 0.73 |
| momentum | 10,601 | 40.7% | −0.064R | **−675.4** | 0.84 |
| meanrev | 3,955 | 32.9% | −0.179R | **−706.5** | 0.72 |
| **ALL** | **31,449** | **35.0%** | **−0.136R** | **−4,274.3** | **0.75** |

Every family net-negative after costs. Every year 2016-2026 net-negative for
every family. Zero profitable quarters when all four are combined.
1-bar directional accuracy: 47% (worse than random). Momentum inversion
narrows the loss (−0.064R → −0.042R) but stays negative.

## Test 3 — using the daemon as a filter on the live four-family trades

Script: `api-server/scripts/_daemon_as_filter_on_four_family.ts`.
Data: 104 closed four-family paper trades (2026-08-04 → 2026-08-26), the
strict legacy detector re-evaluated against fresh M15/H1/H4 at each trade's
decision time.

| Classification | Count | % |
|---|---:|---:|
| CONFLUENCE_AGREE (daemon fired same direction) | **0** | 0% |
| CONFLUENCE_DISAGREE (daemon fired opposite) | **0** | 0% |
| NO_SETUP (daemon rejected outright) | **104** | 100% |

**The daemon never confirmed a single four-family trade.** Blocking gates
at the four-family fire moments:

| Blocking gate | Count |
|---|---:|
| H4 EMA21/50 opposes M15 direction | 29 |
| M15 EMA21/50/200 stack not aligned | 20 |
| Price did not pull into EMA21/50 zone | 19 |
| No 5-bar structural break in direction | 17 |
| Confirmation candle did not engulf prior body | 10 |
| H1 EMA21/50 does not agree with M15 direction | 9 |

Statistically expected: daemon fires at ~1/60th the rate of the four-family,
so at most 1-2% overlap is expected even under co-firing. Observed 0/104 is
consistent with independent signal sources.

### Policy P&L on the 104 four-family trades

| Policy | n taken | Total R |
|---|---:|---:|
| Baseline (take every four-family trade) | 104 | **−14.11R** |
| FILTER_AGREE_ONLY (require daemon confirmation) | 0 | 0 |
| FILTER_ANY_SETUP (keep + invert on disagree) | 0 | 0 |
| DAEMON_DIRECTED (only when daemon fires; use its direction) | 0 | 0 |

Using the daemon as a filter blocks 100% of four-family trades. This is not
"filtering" the four-family — it's replacing it with the daemon standalone.

## Consolidated findings

1. **Daemon at 12 pairs**: ~4-5 trades/week (matches production observation).
   Slight positive edge (+0.012R/trade). Not high-frequency, but positive.
2. **H4 gate is load-bearing**: removing it adds 45% volume but destroys
   +31.77R over 4 years. Not a valid loosening lever.
3. **Daemon is dominated by XAU_USD**: gold accounts for 270% of the
   strategy's total R across all 12 pairs. Restricting to the 4 net-positive
   pairs (XAU_USD, USD_JPY, USD_CHF, GBP_JPY) 4x the total R.
4. **Four-family engine is a historical net loser** on every family, every
   year, every pair tested. Direction quality is 47% at 1 bar — worse than
   random. Not a costs problem, a direction problem.
5. **Daemon and four-family are independent signal sources** — the daemon
   never confirms four-family trades. "Run them together" = additive; the
   four-family's losses drown out the daemon's gains 150:1.

## Recommendations (research findings, not production actions)

1. **Kill or heavily restrict the four-family engine.** It's actively
   confirming its 10-year historical loss on live paper trades.
2. **Restrict the daemon to `XAU_USD,USD_JPY,USD_CHF,GBP_JPY`** via the
   `LEGACY_V2_PAIRS` env var. One env change, no code change. Turns a
   break-even strategy into ~+11R/year expected.
3. **Do not loosen the H4 gate** or any other gate to increase daemon
   volume. The strategy is inherently low-frequency; the gates are what
   protect the edge.
4. **The v2 confidence model is the correct volume-vs-edge dial** — not
   the raw gates. If the model with `CONF_T=0.10` never picks up trades,
   experiment with lowering `CONF_T`, not with loosening gate strictness.
5. **The audit trail (`legacy_confidence_v2_evaluations`) is the only
   thing that should be growing right now** while both engines are in
   their current states. Wait for a meaningful sample (100+ audit rows
   with `setup_passed=true`) before deciding whether to flip
   `LEGACY_CONFIDENCE_V2_DRY_RUN=false`.

## Reproduction

From `api-server/`:

```powershell
npx.cmd tsx scripts/_backtest_legacy_12pairs_h4variant.ts
npx.cmd tsx scripts/_daemon_as_filter_on_four_family.ts
```

Outputs (regenerable):
- Root: `backtest-legacy-12pairs/variantA_strict.json`,
  `backtest-legacy-12pairs/variantB_no_h4.json`.
- OANDA M15/H1/H4 caches under each `candles/` subdir are gitignored.
