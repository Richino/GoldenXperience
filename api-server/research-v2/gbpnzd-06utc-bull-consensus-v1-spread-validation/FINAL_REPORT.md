# GBPNZD 06UTC Bull Consensus V1 — frozen TradingView cohort executable validation

> **LOSING · FAILS_COSTS · RESEARCH_ONLY · PAPER_ONLY**

## Cohort parity

- TradingView: **216** trades; **112** wins; **104** losses; **51.85%** WR.
- Matched: **213 / 216**. Unmatched: **3**. Resolved executable: **213**.
- DST-aware America/New_York resolution: **216/216** entries resolve to 06:00 UTC. No OANDA-derived signals were generated.
- OANDA H1 midpoint parity: max entry difference 0.600 pips; consensus failures 0; geometry flags 68.

## Results

| Replay | N | Wins | Losses | WR | PF | Total R | Expectancy | Avg win | Avg loss | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| MID | 213 | 111 | 102 | 52.11% | 1.411 | 37.5692R | 0.1764R | 1.1619R | -0.8960R | 10.9353R |
| EXEC | 213 | 86 | 127 | 40.38% | 0.790 | -25.7246R | -0.1208R | 1.1270R | -0.9657R | 38.6924R |

## Cost drag

- Average: **0.2972R/trade**. Total: **63.2938R**.
- By executable exit: TP 32: 4.7832R total / 0.1495R avg; SL 97: 30.9930R total / 0.3195R avg; TIME 84: 27.5176R total / 0.3276R avg.
- M1 ambiguity: EXEC **0**, MID **0**; a same-minute TP/SL touch is flagged and resolved conservatively stop-first.

## Year stability — EXEC

| Year | N | WR | PF | Total R | Expectancy | Status |
|---|---:|---:|---:|---:|---:|---|
| 2023 | 53 | 43.40% | 1.241 | 6.6874R | 0.1262R | POSITIVE |
| 2024 | 61 | 40.98% | 0.712 | -10.8349R | -0.1776R | NEGATIVE |
| 2025 | 65 | 41.54% | 0.695 | -11.2862R | -0.1736R | NEGATIVE |
| 2026 | 34 | 32.35% | 0.494 | -10.2909R | -0.3027R | NEGATIVE |

## Final decision

- Classification: **LOSING** (EXEC expectancy -0.1208R/trade).
- Cost verdict: **FAILS_COSTS**.
- Candidate decision: **reject**.
- Explicit confirmations: **NO RULE CHANGE · NO NEW SIGNAL COHORT · NO DEPLOYMENT · NO BROKER ORDERS**.

Method: authoritative CSV cohort only; OANDA Practice completed H1/M1 MBA data; frozen geometry is OANDA H1 midpoint close ± one/two ATR14; MID exits use midpoint and EXEC enters ASK with BID TP/SL/TIME exits. No second spread charge.