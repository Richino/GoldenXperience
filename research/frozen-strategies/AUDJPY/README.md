# AUDJPY frozen strategy artifacts

Authoritative frozen TradingView strategy artifacts for
**GX AUDJPY Bull Consensus V1 - 1 to 2 RR** (OANDA:AUDJPY, H1).

- `strategy.pine` — canonical Pine, supplied verbatim. Source of truth.
- `tradingview-trades.csv` — TradingView Strategy Tester export, verbatim (247 entries / 247 exits).
- `oanda-h1-mid.csv` — OANDA AUD_JPY H1 MIDPOINT candles (2022-10-02 → 2026-09-04), fetched read-only for parity.
- Do not modify `strategy.pine` or `tradingview-trades.csv`.

## Contract (consensus-only — no other filter)

- Origin: completed **12:00 UTC** H1 candle, on/after 2023-01-01 UTC.
- Direction: **LONG only**.
- Four-vote consensus (EMA20 vs EMA50, close vs EMA20, EMA20 vs EMA20[3], close vs close[3]) must total **≥ +3**.
- Entry = signal-candle midpoint close; Stop = 1 frozen ATR14; Target = 2 frozen ATR14.
- Max hold = 3 future H1 bars (13:00 / 14:00 / 15:00), time-exit at close of future bar #3.
- No structure / breakout / EMA-reclaim / body / extreme-close / session / RSI / ADX / HTF / ML filter.

## Parity result (2026-09-11)

TradingView entries 247 · TypeScript signals 247 · exact timestamp matches **247** ·
TV-only 0 · TS-only 0 · direction mismatches 0 → **AUDJPY_PINE_PARITY_CONFIRMED**.

TypeScript evaluator: `frontend/src/lib/strategy/strategies/audjpy-strategy.ts`
(`evaluateAudjpyBullConsensusV1`). Pine geometry uses the midpoint close;
OANDA-practice execution retains the actual ASK fill, kept separate.
