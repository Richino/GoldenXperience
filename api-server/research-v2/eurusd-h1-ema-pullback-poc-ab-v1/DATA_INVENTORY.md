# Data inventory — EURUSD H1 EMA pullback POC A/B v1

Written **before** profitability evaluation.

## Source

- Vendor: OANDA practice/live historical MBA candles (`price=MBA`)
- Instrument: `EUR_USD`
- Timezone: candle `time` is the **open** timestamp in UTC, as returned by OANDA
- Volume field: OANDA candle `volume` = tick/activity count, **not** centralized FX volume

## EURUSD H1

- Start (first completed open): 2019-01-01T22:00:00.000000000Z
- End (last completed open): 2026-09-04T20:00:00.000000000Z
- Request window: 2019-01-01T00:00:00.000Z ≤ t < 2026-09-05T00:00:00.000Z
- Completed candles after normalize: 47797
- Bid availability: YES (OHLC)
- Ask availability: YES (OHLC)
- Mid availability: YES (OHLC)
- Duplicate timestamps collapsed: 0
- Conflicting duplicate timestamps: 0
- Malformed/incomplete MBA rows dropped: 0
- Weekend-sized gaps (≥12h after bar close): 406
- Unexpected intraweek gaps: 1

## EURUSD M5 (POC + path)

- Start: 2019-01-01T22:00:00.000000000Z
- End: 2026-09-04T20:55:00.000000000Z
- Completed candles after normalize: 572202
- Bid/ask/mid: YES
- Bars with volume > 0: 572202
- Duplicate timestamps collapsed: 0
- Conflicting duplicates: 0
- Malformed dropped: 0
- Weekend-sized gaps: 406
- Unexpected intraweek gaps: 1028

## EURUSD M1

- Not stored as a full-history cache (too large).
- Fetched on demand for M5 bars that touch both stop and target.
- Bid/ask used when the window returns completed M1 MBA candles.

## Weekend handling

Weekly shutdown is inferred from the quote calendar: if the next bar opens ≥ 12 hours after the current bar closes, the current bar is the last executable bar of the week. No hard-coded UTC close hour.

## Notes

- History is whatever OANDA returned in this window. Missing years were not fabricated.
- Signals use H1 mid. Execution uses bid/ask.
