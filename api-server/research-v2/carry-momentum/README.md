# carry-momentum-v1 (wave 2 — D1 portfolio)

Isolated **RESEARCH_ONLY** cross-sectional carry + momentum portfolio.

```bash
cd api-server
npm run cm:ingest-yields   # FRED IR3TIB01* short rates + DFF
npm run cm:hunt            # D1 portfolio backtest (DEV; sealed locked)
npm run cm:report          # FINAL_REPORT_D1.txt
```

- Primary TF: **D1** (aggregated from OANDA H1; no native D1 in DB)
- Does **not** modify V1 strategies or `LIVE_EXECUTABLE_FAMILIES` (must stay `[]`)
- Sealed read only after DEV + robustness pass

See `FINAL_REPORT_D1.txt` for latest results.
