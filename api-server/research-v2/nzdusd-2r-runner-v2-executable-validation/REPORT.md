# NZDUSD Corrected 2R Runner V2 — exact OANDA executable bid/ask validation

> Research/paper only. No rule was optimized; no strategy was deployed; no broker order was placed. Read-only OANDA Practice M1 bid/ask.

## Verdict: NO_RUNNER_EDGE

**Conservative (primary) runner** EXEC expectancy **0.1582R/trade** vs frozen **0.1898R/trade** (Δ **-0.0316R/trade**). **Optimistic ceiling** **0.2438R/trade** (Δ **+0.0540R/trade**). The runner edge sign is **not resolvable at M1 granularity** — see the resolution limit below — and the spec-mandated conservative primary gives **NO_RUNNER_EDGE**.

## Resolution limit — why M1 cannot settle a 0.20R trail

The 0.20R trail equals ~1.8–3.6 pips on NZDUSD (1R = ATR14 ≈ 9–20 pips), which is **finer than a single M1 bar**. Runner activations cluster on the 12:30 UTC US-data release, where one M1 bar can span several R (e.g. trade 42's activation bar covers **−0.08R → +5.56R → close +5.30R in one minute**). For such a bar the M1 OHLC is consistent with exits anywhere from the +1.80R floor (tag → dip → stop) to near the MFE (tag → run → trail). We therefore bracket every runner between two OHLC-consistent bounds and do not fabricate tick order:

- **Conservative (primary):** worst OHLC-consistent path each bar (the spec's conservative chronology).
- **Optimistic:** favorable path — exit only on a forced close-through or a clean static stop.

Same-bar MFE/stop ambiguity touches **16 of 27** runners, and the two bounds straddle the frozen expectancy (0.1582R ↔ 0.2438R vs 0.1898R). Resolving this would need OANDA **tick** bid/ask, which is not available here. This is the H1 intrabar problem re-appearing at M1: a 0.20R trail is a sub-M1 construct.

## Baseline parity gate

Frozen EXEC on the matched cohort: trades **100**, WR **48.00%**, PF **1.380**, expectancy **0.1898R**, total **18.9782R**. Expected ≈ 100 / 48.00% / 1.380 / +0.1898R / +18.9782R. **PASS.**

## Overall comparison

| Metric | Frozen EXEC | Runner EXEC (conservative) | Runner EXEC (optimistic) |
|---|---:|---:|---:|
| Trades | 100 | 100 | 100 |
| Wins | 48 | 48 | 48 |
| Losses | 52 | 52 | 52 |
| Win rate | 48.00% | 48.00% | 48.00% |
| Profit factor | 1.380 | 1.317 | 1.488 |
| Total R | 18.9782R | 15.8173R | 24.3823R |
| Expectancy R/trade | 0.1898R | 0.1582R | 0.2438R |
| Average winner R | 1.4359R | 1.3700R | 1.5485R |
| Average loser R | -0.9605R | -0.9605R | -0.9605R |
| Max drawdown R | 11.3552R | 11.3552R | 11.3552R |

## Runners

Reached executable +2R (activated): **27** of 100 (**27.00%**). Activation = the frozen +2R target; in executable terms that averages ~+1.96R because of the entry half-spread, so the protective floor sits at +1.80R exec.

Final exit buckets (executable R):

| Bucket | Runners (conservative) | Runners (optimistic) |
|---|---:|---:|
| <1.80R | 0 | 0 |
| 1.80-1.99R | 26 | 19 |
| 2.00-2.49R | 1 | 4 |
| 2.50-2.99R | 0 | 2 |
| 3.00-3.99R | 0 | 1 |
| 4.00-4.99R | 0 | 0 |
| >=5.00R | 0 | 1 |

Runner statistics (conservative primary; optimistic in brackets):

- Count **27**; average **1.8116R** [2.1288R]; median **1.8000R** [1.8146R]; max **2.0395R** [5.3566R].
- ≥+2R **1** [8]; ≥+2.5R **0** [4]; ≥+3R **0** [2]; ≥+4R **0** [1]; ≥+5R **0** [1].
- Duration (conservative primary): average **2.56h**; median **2.58h**; max **3.82h** (optimistic max **3.82h**). Runners crossing the 17:00 NY rollover: **0** conservative / **0** optimistic — the tight trail closes every runner intraday, so the 48h cap never binds.

Runners finishing below +1.80R executable: **0**. None.

## Baseline +2R winners → runner

All 27 runners were baseline +2R winners. Runner < baseline: **26**; runner ≈ baseline: **0**; runner > +2.5R: **0**; > +3R: **0**; > +4R: **0**; > +5R: **0**.
Total R gained from extended winners: **+0.1059R**. Total R given back by runners that fell toward +1.8R: **-3.2668R**. Net runner-vs-frozen on activated trades (conservative): **-3.1608R**.
Even the **optimistic** ceiling's whole advantage is a 2-trade artifact: trades 42 (+3.42R) and 24 (+1.79R) contribute **+5.22R** of the **+5.40R** optimistic gain over baseline; the other 25 runners add **+0.19R** combined. Both are 12:30-UTC US-data spikes — not a repeatable trailing edge.

## Non-runner parity

Non-runners: **73**. Exact matches: **73**. Mismatches: **0**. Non-runners inherit the frozen result by construction (activation is the frozen +2R target), so parity is exact.

## Overnight (runners) — EXEC BEFORE FINANCING

| Duration | Runners | Total R |
|---|---:|---:|
| <=3h | 19 | 34.2000R |
| 3-6h | 8 | 14.7130R |
| 6-12h | 0 | 0.0000R |
| 12-24h | 0 | 0.0000R |
| 24-48h | 0 | 0.0000R |

Runners crossing the 17:00 New York rollover: **0**. Financing is not applied (no reliable per-trade financing data): all figures are **EXEC BEFORE FINANCING**. Friday-entry runners whose 48h cap lands inside the weekend close exit at the last available Friday price (weekend-truncated).

## Year stability

| Year | Trades | Runners | Frozen PF | Frozen Total R | Frozen Exp | Runner PF | Runner Total R | Runner Exp |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 33 | 9 | 1.198 | 3.6398R | 0.1103R | 1.130 | 2.3940R | 0.0725R |
| 2024 | 23 | 9 | 1.649 | 7.7353R | 0.3363R | 1.556 | 6.6250R | 0.2880R |
| 2025 | 27 | 4 | 0.926 | -1.0433R | -0.0386R | 0.909 | -1.2960R | -0.0480R |
| 2026 | 17 | 5 | 2.577 | 8.6464R | 0.5086R | 2.477 | 8.0943R | 0.4761R |

## Ambiguous same-minute events

Trades with any same-minute MFE/stop ambiguity: **16** (17 minute(s)). Primary uses conservative chronology; optimistic is reported alongside. 

## Decision

Conservative (primary) runner improvement **-0.0316R/trade** ⇒ **NO_RUNNER_EDGE**. Optimistic ceiling improvement **+0.0540R/trade** (would classify RUNNER_EDGE). Because the two bounds straddle zero, the outcome is **indeterminate at M1**; under the spec-mandated conservative primary the runner does **not** beat frozen, so this is **NOT** a RUNNER_CANDIDATE_FOR_PORTFOLIO_TEST. Not frozen, not deployed, no rule changed. Definitive resolution requires OANDA tick data.

Method: exact 100-trade matched cohort; 1R = frozen ATR14; entry = signal H1 ASK close; all runner triggers/MFE/stops on BID; activation = frozen +2R target (guarantees exact non-runner parity); protected floor +1.80R exec; trail 0.20R behind MFE; 48h max hold; same-minute ambiguity resolved by simulating both OHLC-consistent chronologies (primary = conservative). No second spread subtraction. No optimization.