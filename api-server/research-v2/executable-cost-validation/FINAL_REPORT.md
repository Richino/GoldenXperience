# EXECUTABLE COST VALIDATION VERDICT

Source: OANDA practice historical MBA candles. Signals and indicators use completed midpoint candles. LONG enters at ASK and exits on BID; SHORT enters at BID and exits on ASK. Same-timeframe bars that contain both stop and target resolve stop-first. Frozen signals were not altered.

| Pair | MID N | MID PF | MID EXP | EXEC N | EXEC WR | EXEC PF | EXEC EXP | Avg spread | Cost R/trade | 2023 EXP | 2024 EXP | 2025 EXP | 2026 EXP | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| EUR_USD | 356 | 1.327 | 0.197 | 356 | 38.48% | 1.127 | 0.078 | 1.558 | 0.119 | 0.010 | 0.166 | 0.041 | 0.117 | SURVIVES |
| USD_JPY | 67 | 1.698 | 0.286 | 67 | 46.27% | 1.384 | 0.175 | 1.625 | 0.111 | 0.006 | 0.137 | 0.256 | 0.394 | SURVIVES |
| GBP_USD | 79 | 1.487 | 0.267 | 79 | 43.04% | 1.242 | 0.136 | 1.891 | 0.131 | n/a | n/a | 0.193 | 0.057 | SURVIVES |
| AUD_USD | 195 | 1.441 | 0.210 | 195 | 45.64% | 1.232 | 0.118 | 1.279 | 0.092 | 0.008 | 0.166 | -0.057 | 0.386 | SURVIVES |
| NZD_USD | ref | 1.318 | 0.152 | ref | n/a | 0.837 | -0.094 | n/a | 0.246 | n/a | n/a | n/a | n/a | FAILS_COSTS |

## EUR_USD — SURVIVES

Period: 2023-01-01T00:00:00.000Z to 2026-09-01T00:00:00.000Z (exclusive).

Parity caveat: conservative stop-first OANDA H1 replay produced 142/356 winners versus the supplied approximate Pine headline of 146/356. There were 9 midpoint same-bar ambiguities; a TradingView inferred-path diagnostic produced 147/356, not 146. Exact Pine outcome identity therefore remains unproven, although N and PF are within the declared parity tolerance. The executable result below is deliberately the conservative branch.

Midpoint: N 356; wins 142; non-positive 214; WR 39.89%; TP/SL/TIME 142/214/0; net 70.000R; PF 1.327; EXP 0.197R.

Executable: N 356; wins 137; non-positive 219; WR 38.48%; TP/SL/TIME 137/219/0; net 27.735R; PF 1.127; EXP 0.078R.

Cost damage: spread avg/median/p95 1.558/1.600/1.800 pips; entry cost avg/median 0.141/0.137R; total cost avg/median 0.119/0.000R; 60.379% of midpoint expectancy consumed. Outcome changes 5; midpoint winners becoming non-positive 5; positive midpoint TIME_EXITs becoming losses 0.

| Direction | N | WR | PF | EXP R |
|---|---:|---:|---:|---:|
| LONG | 179 | 38.55% | 1.130 | 0.080 |
| SHORT | 177 | 38.42% | 1.123 | 0.076 |

| Year | N | PF | EXP R |
|---|---:|---:|---:|
| 2023 | 106 | 1.015 | 0.010 |
| 2024 | 95 | 1.287 | 0.166 |
| 2025 | 95 | 1.065 | 0.041 |
| 2026 | 60 | 1.195 | 0.117 |

| Spread scenario | PF | EXP R |
|---|---:|---:|
| actual | 1.127 | 0.078 |
| actual + 0.1 pip | 1.119 | 0.073 |
| actual + 0.25 pip | 1.108 | 0.067 |
| actual + 0.5 pip | 1.078 | 0.048 |

Verdict: SURVIVES.

## USD_JPY — SURVIVES

Period: 2023-01-01T00:00:00.000Z to 2026-09-04T17:29:08.892Z (exclusive).

Midpoint: N 67; wins 33; non-positive 34; WR 49.25%; TP/SL/TIME 16/26/25; net 19.171R; PF 1.698; EXP 0.286R.

Executable: N 67; wins 31; non-positive 36; WR 46.27%; TP/SL/TIME 13/29/25; net 11.738R; PF 1.384; EXP 0.175R.

Cost damage: spread avg/median/p95 1.625/1.600/1.900 pips; entry cost avg/median 0.081/0.075R; total cost avg/median 0.111/0.000R; 38.771% of midpoint expectancy consumed. Outcome changes 5; midpoint winners becoming non-positive 2; positive midpoint TIME_EXITs becoming losses 1.

| Direction | N | WR | PF | EXP R |
|---|---:|---:|---:|---:|
| LONG | 40 | 47.50% | 1.418 | 0.194 |
| SHORT | 27 | 44.44% | 1.331 | 0.147 |

| Year | N | PF | EXP R |
|---|---:|---:|---:|
| 2023 | 20 | 1.010 | 0.006 |
| 2024 | 14 | 1.309 | 0.137 |
| 2025 | 24 | 1.682 | 0.256 |
| 2026 | 9 | 2.064 | 0.394 |

| Spread scenario | PF | EXP R |
|---|---:|---:|
| actual | 1.384 | 0.175 |
| actual + 0.1 pip | 1.380 | 0.174 |
| actual + 0.25 pip | 1.306 | 0.145 |
| actual + 0.5 pip | 1.297 | 0.141 |

Verdict: SURVIVES.

## GBP_USD — SURVIVES

Period: 2025-01-06T00:00:00.000Z to 2026-09-04T17:29:08.892Z (exclusive).

Midpoint: N 79; wins 35; non-positive 44; WR 44.30%; TP/SL/TIME 30/43/6; net 21.095R; PF 1.487; EXP 0.267R.

Executable: N 79; wins 34; non-positive 45; WR 43.04%; TP/SL/TIME 30/44/5; net 10.754R; PF 1.242; EXP 0.136R.

Cost damage: spread avg/median/p95 1.891/1.900/2.200 pips; entry cost avg/median 0.172/0.173R; total cost avg/median 0.131/0.000R; 49.022% of midpoint expectancy consumed. Outcome changes 1; midpoint winners becoming non-positive 1; positive midpoint TIME_EXITs becoming losses 1.

| Direction | N | WR | PF | EXP R |
|---|---:|---:|---:|---:|
| LONG | 43 | 44.19% | 1.288 | 0.156 |
| SHORT | 36 | 41.67% | 1.192 | 0.112 |

GBP netting constraint: 0 opposite-direction overlapping signals were blocked; all 79 independent leg signals remained, so netted metrics are unchanged.

| Year | N | PF | EXP R |
|---|---:|---:|---:|
| 2025 | 46 | 1.349 | 0.193 |
| 2026 | 33 | 1.100 | 0.057 |

| Spread scenario | PF | EXP R |
|---|---:|---:|
| actual | 1.242 | 0.136 |
| actual + 0.1 pip | 1.233 | 0.131 |
| actual + 0.25 pip | 1.155 | 0.089 |
| actual + 0.5 pip | 1.097 | 0.057 |

Verdict: SURVIVES.

## AUD_USD — SURVIVES

Period: 2023-01-01T00:00:00.000Z to 2026-09-04T12:00:00.000Z (exclusive).

Midpoint: N 195; wins 96; non-positive 99; WR 49.23%; TP/SL/TIME 45/87/63; net 41.004R; PF 1.441; EXP 0.210R.

Executable: N 195; wins 89; non-positive 106; WR 45.64%; TP/SL/TIME 38/95/62; net 23.068R; PF 1.232; EXP 0.118R.

Cost damage: spread avg/median/p95 1.279/1.300/1.500 pips; entry cost avg/median 0.128/0.126R; total cost avg/median 0.092/0.000R; 43.743% of midpoint expectancy consumed. Outcome changes 14; midpoint winners becoming non-positive 7; positive midpoint TIME_EXITs becoming losses 6.

LONG only.

| Year | N | PF | EXP R |
|---|---:|---:|---:|
| 2023 | 58 | 1.013 | 0.008 |
| 2024 | 57 | 1.336 | 0.166 |
| 2025 | 40 | 0.894 | -0.057 |
| 2026 | 40 | 2.044 | 0.386 |

| Spread scenario | PF | EXP R |
|---|---:|---:|
| actual | 1.232 | 0.118 |
| actual + 0.1 pip | 1.225 | 0.115 |
| actual + 0.25 pip | 1.195 | 0.100 |
| actual + 0.5 pip | 1.144 | 0.075 |

Verdict: SURVIVES.

# PORTFOLIO AFTER COSTS

- SURVIVES: EUR_USD, USD_JPY, GBP_USD, AUD_USD
- MARGINAL: none
- FAILS_COSTS: NZD_USD
- Completed pairs surviving costs: 4 of 5
- Approximate annual signal frequency, SURVIVES only: 215.941
- Approximate annual signal frequency including MARGINAL: 215.941

These frequencies are arithmetic counts only. Correlation, simultaneous exposure, portfolio drawdown, and capital competition have not been tested.

Classification uses actual historical bid/ask: SURVIVES requires PF > 1.05, EXP > 0.03R, and at least two material positive years; MARGINAL is positive but misses one of those strength/stability tests; PF <= 1 or EXP <= 0 is FAILS_COSTS.

Implementation caveats: EURUSD is currently a registered but dormant evaluator, so its midpoint absolute stop/target geometry is the closest current-code interpretation rather than proof of a live/paper order path. GBPUSD also retains midpoint absolute stop/target levels; USDJPY and AUDUSD rebuild 1R/2R levels around the executable entry, matching their production modules. The GBP start boundary was reconstructed from the supplied 79-trade frozen cohort because no dated parity fixture was present. Historical MBA responses are not immutable cached fixtures.

NO STRATEGY RULES WERE CHANGED DURING THIS TEST.
