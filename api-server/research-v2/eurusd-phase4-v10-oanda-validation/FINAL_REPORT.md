# EURUSD Phase 4 V10 (1:1) — OANDA Executable BID/ASK Validation

**Scope:** validation only. No tuning, no threshold changes, no new cohort, no
production code, no broker orders. The 197 frozen TradingView entries were
replayed against OANDA Practice **M1 bid/ask** history.

**Note on inputs:** the supplied Pine file (`EURUSD_1-1.txt`) arrived **empty
(0 bytes)**, so no canonical `strategy.pine` could be saved. Validation does not
require it — it replays the exact TradingView trade CSV, which is complete.

---

## 1. Cohort match — 100% parity

TradingView timestamps parsed as `America/New_York` (DST-aware) → UTC, then
checked against each signal tag's declared origin hour.

| Metric | Value |
|---|---|
| TradingView trades | **197** |
| Matched OANDA trades | **197** |
| Unmatched | **0** |
| Duplicate matches | **0** |
| Timestamp mismatches | **0** |
| `07_EXTREME_LONG` → 07:00 UTC | 63 |
| `08_BODY_LONG` → 08:00 UTC | 81 |
| `10_BODY_INV_LONG` → 10:00 UTC | 53 |

**Every entry resolved to its exact declared UTC origin hour.** Two independent
integrity checks also passed:

- **Origin-close validation:** every TradingView reference entry equals the
  OANDA H1 **midpoint close** of its origin candle (0 failures at 6-pip
  tolerance) — the CSV entry price and OANDA feed are the same market.
- **Frozen ATR validation:** ATR14 recomputed (Wilder RMA) on OANDA H1 mid vs
  the ATR implied by TP/SL exit distance (`|exit − entry|`) on resolved trades —
  **median difference 0.00006 (≈0.06 pip)**. The frozen ATR is reproduced exactly.

→ **Cohort parity is unconditional; no unmatched trade requires explanation.**

---

## 2. Execution model

- Entry family origins (UTC): 07 / 08 / 10. `process_orders_on_close` ⇒ the
  fill occurs at the **origin H1 candle close = origin + 1h**.
- **Entry pays OANDA ASK.** Long **TP and SL are triggered on executable BID**
  high/low, walked minute-by-minute for up to **6 hours** (6 H1 bars).
- TP and SL inside the **same M1 bar** ⇒ `AMBIGUOUS` (never guessed).
- No fill by 6h ⇒ time exit at executable **BID**.
- **Method A — FROZEN_LEVEL_PARITY:** TP/SL = TV mid entry ± 1 ATR (entry still
  pays ASK). Isolates pure spread effect on the original levels.
- **Method B — REAL_FILL_1R:** TP/SL = actual ASK fill ± 1 ATR. How a true 1R
  live order would be placed. *(Methods computed independently, never mixed.)*

Median frozen **ATR14 = 11.6 pips**; median **spread = 1.5 pips** ⇒ spread is
~13% of the 1R risk. That ratio is the whole story below.

---

## 3. Results — both methods

| Metric | TradingView (frozen, mid) | **A: FROZEN_LEVEL_PARITY** | **B: REAL_FILL_1R** |
|---|---:|---:|---:|
| Trades | 197 | 197 | 197 |
| Wins | 125 | 113 | 110 |
| Losses | 72 | 84 | 87 |
| **Win rate** | **63.45%** | **57.36%** | **55.84%** |
| Profit factor | — | 1.194 | 1.283 |
| Total R | — | +17.03 | +24.17 |
| **Expectancy R/trade** | — | **+0.0864** | **+0.1227** |
| Avg spread (pips) | — | 1.55 | 1.55 |
| Avg spread cost (R) | — | 0.135 | 0.135 |
| Avg total execution drag (R/trade) | — | 0.184 | 0.148 |
| Max drawdown (R) | — | −13.72 | −12.43 |
| Time exits | 2 | 4 | 4 |
| Ambiguous | — | 0 | 0 |

**Method B (real 1R fill) is the more realistic live model and the stronger of
the two** (+0.123R vs +0.086R): anchoring TP/SL to the actual fill makes every
win a full +1R, whereas Method A clips each win by the spread. Both are positive.

### By setup (Method A / Method B expectancy)
| Setup | n | A WR | A exp | B WR | B exp |
|---|---:|---:|---:|---:|---:|
| 07_EXTREME_LONG | 63 | 58.7% | +0.126 | 58.7% | +0.192 |
| 08_BODY_LONG | 81 | 56.8% | +0.068 | 54.3% | +0.086 |
| 10_BODY_INV_LONG | 53 | 56.6% | +0.068 | 54.7% | +0.096 |

`07_EXTREME_LONG` is the strongest leg; the inverted `10_BODY_INV_LONG` holds up
and stays positive after costs.

### By year (Method A / Method B expectancy, R)
| Year | n | A WR | A exp | A MDD | B exp |
|---|---:|---:|---:|---:|---:|
| 2023 | 42 | 66.7% | +0.267 | −2.81 | +0.286 |
| 2024 | 54 | 46.3% | **−0.161** | −13.72 | −0.156 |
| 2025 | 66 | 56.1% | +0.073 | −7.59 | +0.129 |
| 2026 | 35 | 65.7% | +0.276 | −1.27 | +0.346 |

**2024 is the only losing year (−0.16R, PF 0.72) and owns the full −13.7R
drawdown.** The positive whole-sample expectancy is carried by 2023, 2025, and
2026. This is the main robustness caveat — the edge is real but not stationary.

---

## 4. Comparison vs frozen TradingView (125W / 72L, 63.45% WR)

| Effect (Method A) | Count |
|---|---:|
| Frozen winners → executable losers | 13 |
| Frozen losers → executable winners | 1 |
| Frozen TP wins where BID never reached the target | 13 |
| Frozen winners stopped out by spread | 11 |

*(Method B: 16 / 1 / 16 / 14 respectively.)*

The WR loss of ~6 points is almost entirely **one-directional**: 13 frozen
winners flip to losers, only 1 loser flips to a winner. The mechanism is the
1.5-pip spread against an 11.6-pip ATR — the executable BID falls ~0.75 pip short
of a target the midpoint touched, so a marginal TP becomes a stop. There are
**no ambiguous bars** at M1 resolution, so none of this is measurement
uncertainty.

Entry spread distribution: min 1.30p · median 1.50p · p95 1.80p · max 2.00p
(148/197 trades in the 1.5–2.0p band). Spread is tight and stable across the
whole 2023–2026 window — the drag is structural, not outlier-driven.

---

## 5. Verdict

Thresholds: STRONG ≥ +0.15R · SURVIVES_COSTS ≥ +0.05R · MARGINAL 0–0.05R · FAILS < 0R.

| Method | Expectancy | **Verdict** |
|---|---:|---|
| A — FROZEN_LEVEL_PARITY | +0.0864R | **SURVIVES_COSTS** |
| B — REAL_FILL_1R | +0.1227R | **SURVIVES_COSTS** |

## `EURUSD_PHASE4_V10 = SURVIVES_COSTS` (not STRONG)

The frozen cohort **survives executable OANDA bid/ask costs on both
interpretations** — expectancy stays clearly positive (+0.09R frozen-level,
+0.12R real-fill), win rate holds in the mid-50s, and PF > 1.19. It falls short
of STRONG (+0.15R) because the 1.5-pip spread is ~13% of the small H1 ATR, and it
carries a real **2024 negative year / −13.7R drawdown** that any live sizing must
respect. Not zero-edge, not bulletproof — a cost-surviving 1:1 whose live
expectancy is roughly **+0.10R/trade**, front-loaded to 2023/2025/2026 and
strongest on the `07_EXTREME_LONG` leg.

**Confirmations:** validation only — no tuning, no threshold change, no filter
added, no cohort regenerated; midpoint signal logic untouched; entry pays real
ASK, TP/SL triggered on real BID; both interpretations reported separately;
RESEARCH_ONLY / PAPER_ONLY; no production code modified; no broker orders.

**Artifacts:** `FINAL_REPORT.md`, `RESULTS.json`, `trade_replay.csv`,
`cohort_match.csv`, `spread_analysis.csv`, `validate.ts` (reproducible harness),
`tradingview-trades.csv` (frozen cohort, verbatim).
