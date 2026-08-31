# 2-Year Robustness — binary-double-bollinger-1m-v1

Question: is there a **frequent-trade** configuration whose directional bias
**held up over the last 2 years**, not just on one lucky window?

Method: 9 independent 12-trading-day windows sampled quarterly from 2024-08 to
2026-08 (same OANDA M1 mids, same engine). For every configuration
(confirmations × session × direction × pair × BB3), require ≥5 decided trades/day
in **all 9 windows**, then rank by the **worst-window** result — a config only
scores if it persists everywhere. 736 configs met the frequency floor in all 9
windows. Reproduce: `node robustness_2y.mjs <9 window dirs>`.

## Headline: 70% does not persist. The real ceiling is ~55%.

No frequent-trade configuration held anything close to a 70% bias. Across all 736
that traded frequently in every window:

- Best **persistent loss** config: worst-window loss **52.4%**, pooled **55.1%**.
- Best **persistent win** config: worst-window win **50.0%** (a coin flip).

The 70% loss found earlier (ADX·Asia·DOWN) traded ~2.5×/day on one window and
came back at 50% out of sample — it is not in this table because it neither
persisted nor cleared the frequency floor.

## The one config that DID hold up (as a ~55% loss)

**BB(20,2) rejection + Heikin-Ashi reversal + CCI falling, London session**
(all pairs, both a DOWN-side loss lean; "HA+CCI London" in the search):

| Window | Trades | ~/day | Loss rate |
| ------ | -----: | ----: | --------: |
| 2024-08 | 235 | 20 | 53.2% |
| 2024-11 | 215 | 18 | 53.5% |
| 2025-02 | 250 | 21 | 52.4% |
| 2025-05 | 223 | 19 | 52.9% |
| 2025-08 | 239 | 20 | 55.6% |
| 2025-11 | 294 | 25 | 56.1% |
| 2026-02 | 229 | 19 | 53.7% |
| 2026-05 | 280 | 23 | 57.1% |
| 2026-08 | 257 | 21 | 60.3% |
| **Pooled** | **2222** | **~21** | **55.1%** |

Pooled 2-year loss rate **55.1%** (win 44.9%), 95% CI **53.1%–57.2%** — the
interval sits entirely above 50%, so this is a **statistically real** persistent
loss bias, not noise, and it loses in **every** one of the 9 windows at ~21
trades/day. This is the strongest, most durable, frequent configuration in the
study.

## What it is and is not

- It **is** a genuine, frequent, 2-year-persistent bias — the only one found.
- It is **~55% loss, not 70%.** 70% was single-window noise and never repeated.
- Inverted (take the opposite side) it is a **~55% win** — but 55% is below the
  55.56% break-even for an 80% binary payout, so it is still **not profitable**
  after payout, though it clears break-even at a 90% payout (52.63%).

Bottom line: the most that held up over 2 years with frequent trades is a real
but shallow ~55/45 lean. A durable 70% at this frequency does not exist in the
data.
