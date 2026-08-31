# EUR/USD News V12 Forward Shadow

This folder is a prospective, observation-only ledger. It must not contain rows before 2026-08-01 and cannot place orders.

Add newly released high-impact EUR/USD Forex Factory rows to `events.json` using the existing event shape: `releaseTimeUtc`, `currency`, `eventName`, `actual`, and `forecast`. Run `npm run eur-usd:news-v12-shadow:run` from `api-server` after releases. The runner reads OANDA Practice bid/ask candles, updates `ledger.json`, and writes `STATUS.json`.

The frozen rule is not promoted unless at least 60 new resolved trades independently reach at least 40% wins, positive expectancy, and profit factor above 1. Passing that gate permits review only; it does not enable orders.

`V13_STATUS.json` and `v13-ledger.json` track a separate challenger beginning 2026-09-01. V13 keeps every V12 rule and rejects an otherwise eligible entry when spread exceeds 50% of its ATR stop distance. August 2026 is excluded because that loss was already observed before V13 was created.
