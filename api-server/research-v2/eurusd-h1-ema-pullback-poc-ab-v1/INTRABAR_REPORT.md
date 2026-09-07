# Intrabar report — EURUSD H1 EMA pullback POC A/B v1

H1 (and M5) bars can touch both stop and target. Favorable-first fills are forbidden.

## Policy

1. Walk OANDA **M5 bid/ask** after the executable entry.
2. If an M5 bar's executable exit side touches both stop and target, fetch OANDA **M1 MBA** for that window and walk M1.
3. If M1 is missing or still ambiguous, use conservative **stop-first**.
4. Adverse stop gaps fill at the worse executable open. Target gaps fill at the target (no improvement).

## Counts (baseline, versions A+B trade lists)

- Ambiguous M5 bars encountered: 0
- Resolved via M1 path: 0
- Stop-first fallback: 0
- M5-only unambiguous trades: 2047

## Weekend / 48h

Weekend exit uses the last M5 bar before a ≥12h quote gap (OANDA weekly shutdown), not a hard-coded UTC hour.
48h exit is the first H1 open at or after entry timestamp + 48 hours.
