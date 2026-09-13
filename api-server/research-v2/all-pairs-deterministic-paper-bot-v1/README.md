# All-pairs deterministic paper bot v1

This research-only runner applies the exact fixed H1 Asia-range-break strategy to all 68 OANDA `CURRENCY` instruments for August 2026.

It uses executable bid/ask data, currency-specific high-impact news blocks, a 1R target, a 10%-of-risk spread cap, and a conservative loss when an M15 candle reaches both stop and target. Each pair has a separate one-position ledger. The aggregate is **not** a deployable portfolio because it does not limit correlated exposure across pairs.

AI has no decision-making role. The ledger has an explanation packet for an AI to describe a completed setup only.

Run from `api-server`:

```powershell
npx.cmd tsx scripts/run-all-pairs-deterministic-paper-bot-v1.ts
```
