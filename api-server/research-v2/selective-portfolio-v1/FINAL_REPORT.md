# Selective portfolio V1 — DEVELOPMENT_FAIL_DO_NOT_ACTIVATE

This is a development test on previously inspected history, not new out-of-sample validation. 2025-01-06T00:00:00.000Z to 2026-09-01T00:00:00.000Z.

Frozen hypothesis: accept only spread/executable-stop <= 10%, permit one concurrent position, choose the cheapest simultaneous signal. Keep every underlying entry, direction, stop, target and timeout unchanged.

| Arm | Trades | Annual frequency | PF | EXP R | Total R | Annual net R | Avg spread/stop |
|---|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 344 | 208.364 | 1.250 | 0.136 | 46.684 | 28.277 | 0.129 |
| SELECTIVE | 80 | 48.457 | 1.164 | 0.085 | 6.801 | 4.119 | 0.076 |

Same-margin account illustration ($100, 3% equity risk per accepted trade): CONTROL $179.64, drawdown 37.1%; SELECTIVE $116.23, drawdown 32.2%. Margin metadata: UNAVAILABLE_HTTP_503; ILLUSTRATIVE_50_TO_1_AND_WHOLE_UNITS. These account figures include margin-rejected signals; the R table above compares the selector's candidate cohorts before margin rejections.

Skipped 264 trades, including 116 winners and 148 losers. Every skipped outcome and decision reason is retained in decisions.json. No decision used its outcome.

The result does not establish that cheaper signals have better return. The fixed selector fails the combined total-profit/drawdown objective. Do not tune the threshold after this result or activate this version.

Additional pairs are awaiting their own frozen entry definitions. No extra pair-specific implementations were found beyond the four controls and excluded NZDUSD. No existing pair's rules were copied to another instrument. Admission requirements and a prospective 2026-09-07 to 2027-09-07 protocol are recorded in PROTOCOL.json. The prospective collector has not been scheduled or started.

Tests and runnable commands:

- From frontend: npx.cmd tsx scripts/test-selective-portfolio-v1.ts
- From frontend: npx.cmd tsx scripts/selective-portfolio-v1.ts

No production settings, broker orders or strategy implementations were changed.
