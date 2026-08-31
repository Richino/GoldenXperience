# Binary Master — Repainting Audit

## PinBar (commercial .ex4 — source unavailable)

| Question | Assessment |
|----------|------------|
| When is signal known? | Typically when the **bar closes** (pin shape final) |
| Can signal disappear? | **Possible** on some builds if wick shrinks before close |
| Can arrows move? | **Possible** on intrabar recalculation |
| Future bars affect past arrows? | **Possible** in repainting builds |
| Uses incomplete candle? | **Risk** if arrow drawn before bar close |

**STRICT_NON_REPAINTING mitigation:** Evaluate pin rules only on `complete=true` bars; signal fixed after close; no intrabar updates.

---

## SMA CrossOver Justin (commercial .ex4 — source unavailable)

| Question | Assessment |
|----------|------------|
| When is crossover known? | At bar close when both SMAs use only past closes |
| Can signal disappear? | Forum reports: **alerts without arrows**; some versions **repaint** |
| Can arrows move? | Repainting versions may shift historical arrows |
| Future bars affect past signals? | **Yes** if SMA window recalculates retroactively on incomplete bar |
| Uses incomplete candle? | **Risk** on MT4 tick updates |

**STRICT_NON_REPAINTING mitigation:**

- SMA computed causally on closed M1 closes only
- Cross detected at index `i` using SMA values at `i` and `i-1` after bar `i` closes
- Entry **next bar open** — never same-bar close entry

---

## Binary Master combination

| Risk | Mitigation in this experiment |
|------|-------------------------------|
| “Pin first, SMA seconds later” uses lookahead | Primary test: **both on same closed bar T**, enter T+1 open |
| M5 template on M1 data mismatch | Documented; parameters not retuned |
| 70% claim from Martingale / cherry-picked sessions | Primary test: **fixed stake, no Martingale** |
| Manual discretion (“avoid news”) | Not modeled; may inflate marketed results |

---

## Verdict for backtest validity

This replay uses **STRICT_NON_REPAINTING** causal semantics. If commercial indicators repaint, live marketed results could exceed this audit. If indicators are causal, this replay is a fair lower-bound structural test.
