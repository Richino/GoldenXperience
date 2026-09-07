# Causality audit — GX POC SWING LONG ONLY V1

Implementation: `frontend/scripts/usdjpy-poc-swing-long.ts` (research only).

| Item | Result |
|---|---|
| Future H4 information | PASS — previous completed H4 only (`startedIndex - 1`), equivalent to Pine `close[1]` / `EMA[1]` with lookahead off |
| Future POC information | PASS — POC uses previous 24 completed H1 bars; lock frozen at breakout |
| Future H1 candles | PASS — signals use only the current completed H1 bar and prior history |
| Incorrect centered windows | PASS — consolidation is `[i-24, i-1]`, current bar excluded |
| Lookahead EMA calculations | PASS — H4 EMA50/200 computed on the H4 close series, read at the previous-completed index |
| Incorrect breakout range inclusion | PASS — breakout candle is not inside the 24-bar range |
| Future volume bins | PASS — volume is taken from the same previous 24 H1 bars |

Pine source `.pine` file was not in the workspace. This audit covers the research engine against PINE_RULE_SPEC.md.
