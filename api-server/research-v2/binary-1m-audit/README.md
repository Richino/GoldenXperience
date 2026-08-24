# binary-1m-audit

Research-only counterfactual: do existing `binary-baseline-v1` UP/DOWN calls
finish ITM at **T+60s**?

```bash
cd api-server
npx tsx scripts/_binary-1m-audit.ts
```

- Does **not** modify binary strategy, predictions, adaptive engine, or production
- Uses OANDA M1 (same source as `resolveDueBinaryPredictions`)
- Local DB has no M1 candles; that is expected

See `FINAL_REPORT.txt`.
