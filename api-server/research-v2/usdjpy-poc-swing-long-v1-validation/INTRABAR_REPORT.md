# Intrabar report — GX POC SWING LONG ONLY V1

H1 bars can touch both stop and target. Lower-timeframe bid/ask path data was not used to order fills.

Policy: **stop-first** (conservative). Adverse stop gaps fill at the worse open. Target gaps are not improved.

- Midpoint trades with both SL and TP reachable on the same H1 bar: 2 / 180
- Executable (bid) trades with both SL and TP reachable on the same H1 bar: 1 / 180

No M1/M5 path reconstruction was available for this validation, so favorable outcomes were not assumed.
