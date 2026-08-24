# reversal-fade-h1h4-v1

Isolated **RESEARCH_ONLY** test: does the M15 fade/reversal effect become net-positive on H1/H4 after bid/ask costs?

- Does **not** modify V1 strategies or `LIVE_EXECUTABLE_FAMILIES` (must stay `[]`).
- SEALED holdout is **not read** unless a DEV candidate survives robustness.

```bash
cd api-server
npm run rf:hunt
npm run rf:report
```
