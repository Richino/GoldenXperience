# GoldenXperience V2 — Edge Research Engine

Research/shadow-only engine. Does **not** open live paper trades.

V1 families (`ema`, `breakout`, `momentum`, `meanrev`) are frozen benchmarks.
`LIVE_EXECUTABLE_FAMILIES` stays empty until a sealed V2 candidate later earns promotion via forward shadow evidence.

## Philosophy

Predict whether forward FX returns are statistically predictable **after costs**,
then trade only those conditions. Default action is **WAIT**.

## Data zones (never tune on sealed)

| Zone | Role |
|------|------|
| TRAIN | Fit models / scalers |
| DEV | Feature selection, thresholds, reject weak ideas |
| SEALED | Final evaluation only — one shot per frozen candidate |

## Run

```bash
cd api-server
npx tsx research-v2/bin/inventory.ts
npx tsx research-v2/bin/hunt.ts
npx tsx research-v2/bin/report.ts
```

Experiments append to `research-v2/experiments/registry.jsonl` (never deleted).

## Layout

- `src/` — regimes, features, labels, costs, models, validation, hunt loop
- `bin/` — CLI entrypoints
- `experiments/` — durable registry
- `candidates/` — frozen promotion artifacts (`gx-v2-NNN`)
