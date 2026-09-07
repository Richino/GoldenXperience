# Controlled +0.5R/-1R replay

This is a **matched exit-geometry test**, not a retrained model: it replays the same 187 frozen EURUSD_ELITE_DIRECTION_V1 entries and directions from 2025-11-01 through 2026-08-01. Bid/ask execution, 0.1-pip entry/exit slippage, three-hour maximum hold, and conservative same-candle TP/SL handling are unchanged.

| Geometry | Trades | Win rate | Avg R | Total R | PF | Max DD | Target rate | Stops | Time exits | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| +1R/-0.5R control | 187 | 21.4% | -0.1918 | -35.86 | 0.522 | 36.85 | 20.3% | 145 | 2 | 2 |
| +0.5R/-1R | 187 | 55.6% | -0.1759 | -32.89 | 0.608 | 35.35 | 55.6% | 78 | 0 | 5 |

Control reproduction check: **PASS**. Results are independent per frozen entry; they do not alter selection, retrain the model, or change the live/paper engine.
