# Forex Factory event study

Scrapes the Forex Factory economic calendar for the last N days and enriches
each event with OANDA market context. Output is a single JSON file.

Per event you get:

- **Historical actual / forecast / previous / revised** — straight from Forex
  Factory (read from FF's embedded `calendarComponentStates`, so timestamps are
  exact UTC regardless of FF's display timezone).
- **Related data released before the event** — every same-UTC-day release that
  landed earlier (same-currency ones first), with their actual/forecast/previous.
- **Market data before the event** — USD trend and US 2y/10y yield drift over the
  60 min before the release (from OANDA candles; yields are bond-price contracts,
  so the implied yield direction is labelled).
- **Price reaction after the release** — the event currency's own move at +15,
  +30, +60 min, in pips and %, signed from the event currency's perspective.

## Setup

```bash
cd scripts/ff-event-study
npm install
npm run install-browser   # downloads Chromium for Playwright (one-time)
```

OANDA credentials are read from `api-server/.env`
(`OANDA_API_KEY`, `OANDA_ENVIRONMENT`). You can override them with a local
`scripts/ff-event-study/.env`.

## Two ways to get the calendar

Forex Factory sits behind Cloudflare, which blocks automated fetches. There are
two providers:

### A. Saved-file mode — recommended, no Cloudflare fight

You load Forex Factory in your **normal browser** (where Cloudflare already
trusts you) and hand the tool the file. Nothing here automates FF, so there is
nothing to bypass — you are just parsing pages you already viewed.

1. In your everyday browser, open the calendar range you want, e.g.
   `https://www.forexfactory.com/calendar?range=sep1.2026-sep11.2026`
   (or a `?week=` / `?day=` view).
2. Save it: **Ctrl+S → "Webpage, HTML Only"** into a folder, e.g. `saved/`.
   The saved `.html` still contains FF's embedded data (exact UTC timestamps).
   *Or* use FF's **Export** button on the calendar and save the `.json`/`.csv`.
3. Run against the folder:

```bash
npx tsx src/build.ts --input=saved
```

You can drop several files in the folder (multiple weeks, mixed `.html`/`.json`/
`.csv`); they are parsed and de-duplicated. In saved mode the `--days` window is
ignored — you curate the range by which files you save.

### B. Live scrape mode

```bash
npm run build                          # last 10 days, all impacts
npx tsx src/build.ts --days=10 --min-impact=medium
```

This will hit Cloudflare. Run it **headed** the first time and clear the
challenge in the window (it waits up to 3 min); the clearance cookie is saved to
`.ff-state.json` and reused:

```bash
HEADLESS=false npx tsx src/build.ts --days=10
```

Output lands in `out/ff-event-study-YYYY-MM-DD.json`.

### Options

| flag | default | meaning |
|------|---------|---------|
| `--input=DIR` | (live scrape) | parse saved `.html`/`.json`/`.csv` from DIR instead of scraping |
| `--days=N` | `10` | how many days back to cover (live mode only) |
| `--min-impact=low\|medium\|high` | `low` | drop events below this impact |
| `--out=path` | `out/ff-event-study-<date>.json` | output file |
| `--no-market` | off | skip OANDA enrichment (calendar only) |
| `HEADLESS=false` (env) | headless | run the browser visibly (live mode) |

## Cloudflare

Forex Factory sits behind Cloudflare. If a run fails with a "could not read
calendar state / Cloudflare challenge" error, run it **once** headed and solve
the challenge yourself:

```bash
HEADLESS=false npx tsx src/build.ts
```

The clearance cookie is saved to `.ff-state.json` and reused on later runs.
This tool does **not** attempt to bypass or auto-solve any challenge — it is
rate-limited (2.5s between day pages) and intended for personal research use.
Heavy or automated scraping violates Forex Factory's terms of service.
