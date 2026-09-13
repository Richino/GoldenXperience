# Pair strategy router v1

This is a paper-only scanner, not an order submitter. It inventories all 68 broker currency instruments, then routes only the 12 pairs that have a dedicated frozen strategy in `PAIR_STRATEGY_REGISTRY`.

The other pairs return `NO_VALIDATED_STRATEGY`. They are not given a generic fallback rule. A valid candidate must also pass live-market, live-pricing, calendar, news-buffer, and spread-versus-risk checks. Qualified candidates are deterministically ranked; the default maximum is one, and any candidate sharing a currency with the chosen pair is rejected as correlated.

AI receives only the final selected candidate explanation packet. It has no authority over the route, ranking, entry, stop, target, or paper outcome.

Run from `api-server`:

```powershell
npx.cmd tsx scripts/scan-pair-strategy-router.ts
```

For the read-only July-August historical router replay:

```powershell
npx.cmd tsx scripts/replay-pair-strategy-router-last-two-months.ts
```
