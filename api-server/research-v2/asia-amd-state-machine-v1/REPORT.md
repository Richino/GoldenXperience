# Asia-range AMD state machine — raw baseline (v1)

Generated 2026-10-07 by `frontend/scripts/run-asia-amd-baseline.ts` from the
module the chart draws (`frontend/src/lib/strategy/amd.ts`). Default parameters, **nothing tuned**.
OANDA M15 mid candles, 10 pairs, 2023-01-01 → 2026-10-06. High-impact TradingView calendar for the news flag.

Defaults: Asia 00:00–07:00 UTC · sweeps may start 07:00–13:00 · resolution/outcomes until 21:00 ·
any trade through the level is a sweep (minSweepPips 0) · reclaim = close back inside ·
acceptance = 2 closes outside, or one close ≥ 2 M15-ATR outside, or 4 candles without reclaim ·
reclaimMode CLOSE_PLUS_DISPLACEMENT · displacement = body ≥ 1.0 × average body of the previous 20 candles,
closing beyond the previous close in the expected direction, within 4 candles of the reclaim ·
entry = close of the confirming candle.

## 1. Replay proof (no lookahead)

The machine was fed real candles one at a time. After **every** candle, everything it knew
(transitions, frozen Asia levels, sweep starts/sides, distribution entry/direction) was checked against
the full-history run; every 96 candles a fresh run on the truncated series was checked for exact equality.

| pair | window | days | cuts checked | fresh replays | violations |
|---|---|---|---|---|---|
| EUR_USD | Jun–Aug 2026 | 86 | 8268 | 87 | 0 |
| GBP_USD | Jun–Aug 2026 | 86 | 8268 | 87 | 0 |
| USD_JPY | Jun–Aug 2026 | 86 | 8268 | 87 | 0 |

Previous implementation (git HEAD `amd.ts`), same check — cut after every London/NY candle of each
2026 day and compared with what it showed once the day was over:

| pair | resolved days | resolved label later changed | "breakout" later relabelled manipulation | direction flipped | M box starts 07:00 though 07:00 was inside the range |
|---|---|---|---|---|---|
| EUR_USD | 197 | 58.4% (115) | 38 | 98 | 44 |
| GBP_USD | 197 | 51.3% (101) | 33 | 90 | 59 |

## 2. Funnel: SWEEP → RECLAIM → DISPLACEMENT → OUTCOME

| step | count | rate |
|---|---|---|
| Asia sessions (valid) | 9770 | (0 invalid: holidays / thin data) |
| London swept at least one side | 8826 | 90.3% of sessions |
| no sweep | 934 | 9.6% |
| first sweep reclaimed (close back inside) | 5642 | 63.9% of swept days |
| first sweep accepted (continuation) | 3170 | 35.9% of swept days |
| days with any reclaim | 5651 | 64.0% of swept days |
| reclaims (all attempts) | 6349 | – |
| → displacement in time (D) | 4019 | 63.3% of reclaims |
| → no displacement in 4 candles | 223 | 3.5% |
| → closed back outside first | 2106 | 33.2% |
| → other side swept first | 1 | 0.0% |
| **DISTRIBUTION_CONFIRMED days** | **4019** | 41.1% of sessions |
| BREAKOUT_ACCEPTED days | 4725 | 48.4% (closes 4449, distance 276, timeout 0) |
| EXPIRED days (reclaimed, never displaced) | 82 | 0.8% |
| double-sweep days (both sides swept while the machine was still deciding) | 29 | 0.3% |

Context, measured after the fact and never fed to the machine: London (07–13) traded through **both**
Asian sides on 18.5% of sessions — most of those after the day had
already resolved, which is why the in-sequence double sweep is rare. Of the 4725 accepted
breakouts, **29.9% later traded through the other Asian side by 21:00** —
the days the previous implementation relabelled as "manipulation" after the fact.

## 3. Outcome after confirmed AMD (from the confirming close, until 21:00 UTC)

Which comes first, +X or −X pips. **A coin flip is 50%.** "Same candle" counts against the setup.

| target | n decided | first +X | first −X | same candle | neither by 21:00 |
|---|---|---|---|---|---|
| ±5p | 4019 | 46.6% ±1.5 | 44.2% | 9.1% | 0 |
| ±10p | 4002 | 50.0% ±1.5 | 48.2% | 1.8% | 17 |
| ±15p | 3903 | 50.6% ±1.6 | 48.5% | 0.9% | 116 |
| ±20p | 3677 | 49.8% ±1.6 | 49.6% | 0.6% | 342 |

Median MFE 25.1p, median MAE 25.0p.
Median spread at entry 1.7p.

Asia levels as targets: midpoint reached (or already passed at entry) 78.7%;
**opposite Asia boundary reached 49.4%** (27 already beyond it at entry);
median time to it 210 min. Median structural R:R (reward to the far boundary / risk to the sweep extreme) 2.53.

Structural trade (stop at the sweep extreme, target the opposite Asia boundary, closed at 21:00):
n 3992, win 30.4%, avg **0.03R gross / -0.17R net of spread** (sum -695.1R).
Same trade in CLOSE mode (reclaim alone confirms): n 5642, win 17.9%, 0.04R gross / -0.48R net.

### Comparisons on the same days

Every first reclaim, displacement or not (from the reclaim close, in the AMD direction):

| target | n decided | first +X | first −X | same candle | neither by 21:00 |
|---|---|---|---|---|---|
| ±5p | 5651 | 46.1% ±1.3 | 44.6% | 9.3% | 0 |
| ±10p | 5630 | 48.8% ±1.3 | 49.1% | 2.1% | 21 |
| ±15p | 5480 | 49.8% ±1.3 | 49.3% | 1.0% | 171 |
| ±20p | 5171 | 49.8% ±1.4 | 49.6% | 0.6% | 480 |

Accepted breakouts, traded as continuation (from the acceptance close, in the breakout direction):

| target | n decided | first +X | first −X | same candle | neither by 21:00 |
|---|---|---|---|---|---|
| ±5p | 4725 | 43.3% ±1.4 | 46.3% | 10.4% | 0 |
| ±10p | 4705 | 48.5% ±1.4 | 48.8% | 2.7% | 20 |
| ±15p | 4569 | 49.8% ±1.4 | 49.1% | 1.1% | 156 |
| ±20p | 4300 | 50.1% ±1.5 | 49.2% | 0.7% | 425 |

## 4. Breakdowns (confirmed AMD days)

| pair | sessions | swept | AMD | +10 before −10 | structural n | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|
| EUR_USD | 977 | 96.4% | 467 | 49.6% ±4.5 | 459 | 0.08 | -0.12 |
| GBP_USD | 977 | 96.7% | 450 | 51.1% ±4.6 | 446 | 0.07 | -0.12 |
| USD_JPY | 977 | 86.2% | 373 | 49.9% ±5.1 | 373 | -0.00 | -0.14 |
| AUD_USD | 977 | 84.0% | 357 | 48.6% ±5.2 | 357 | -0.11 | -0.30 |
| USD_CAD | 977 | 96.0% | 449 | 52.1% ±4.6 | 448 | 0.07 | -0.20 |
| USD_CHF | 977 | 97.0% | 435 | 49.7% ±4.7 | 431 | 0.02 | -0.20 |
| NZD_USD | 977 | 87.5% | 376 | 49.6% ±5.1 | 376 | -0.10 | -0.34 |
| EUR_JPY | 977 | 88.9% | 380 | 46.3% ±5.0 | 376 | -0.05 | -0.21 |
| GBP_JPY | 977 | 90.8% | 403 | 49.1% ±4.9 | 398 | 0.03 | -0.15 |
| AUD_JPY | 977 | 79.7% | 329 | 53.8% ±5.4 | 328 | 0.24 | 0.04 |

| year | AMD | +10 before −10 | structural n | avg R gross | avg R net |
|---|---|---|---|---|---|
| 2023 | 1136 | 49.7% ±2.9 | 1127 | 0.03 | -0.14 |
| 2024 | 1064 | 48.5% ±3.0 | 1057 | 0.06 | -0.15 |
| 2025 | 1060 | 51.4% ±3.0 | 1056 | -0.00 | -0.20 |
| 2026 | 759 | 50.5% ±3.6 | 752 | 0.02 | -0.22 |

| direction | AMD | +10 before −10 | avg R gross | avg R net |
|---|---|---|---|---|
| long | 1972 | 51.5% ±2.2 | 0.04 | -0.16 |
| short | 2047 | 48.5% ±2.2 | 0.02 | -0.19 |

**Q7 — sweep depth (the sweep that completed)**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| a 0–2p | 1534 | 51.6% ±2.5 | 51.8% ±2.7 | 54.4% | 1527 | 32.2% | 0.07 | -0.17 |
| b 2–5p | 1374 | 47.2% ±2.6 | 46.0% ±2.8 | 47.5% | 1367 | 27.4% | -0.10 | -0.30 |
| c 5–10p | 786 | 52.7% ±3.5 | 51.6% ±3.5 | 45.3% | 777 | 31.4% | 0.13 | -0.03 |
| d 10p+ | 325 | 47.4% ±5.4 | 52.0% ±5.5 | 44.0% | 321 | 32.1% | 0.10 | -0.00 |

**Q8 — Asia range size (range / daily ATR, terciles)**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| a < 0.32 ATR | 1339 | 50.7% ±2.7 | 50.1% ±2.8 | 67.0% | 1320 | 42.0% | 0.09 | -0.15 |
| b 0.32–0.46 ATR | 1340 | 48.8% ±2.7 | 49.2% ±2.8 | 51.9% | 1335 | 29.5% | -0.02 | -0.22 |
| c ≥ 0.46 ATR | 1340 | 50.4% ±2.7 | 50.2% ±2.8 | 29.5% | 1337 | 19.7% | 0.02 | -0.15 |

**Asia quality score (terciles; recorded, not filtered)**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| a low (< 0.56) | 1339 | 50.4% ±2.7 | 49.3% ±2.8 | 35.3% | 1335 | 22.3% | 0.03 | -0.15 |
| b mid | 1340 | 49.4% ±2.7 | 50.6% ±2.8 | 51.6% | 1330 | 30.5% | 0.02 | -0.19 |
| c high (≥ 0.69) | 1340 | 50.1% ±2.7 | 49.5% ±2.8 | 61.4% | 1327 | 38.4% | 0.03 | -0.18 |

**Q9 — London hour of the sweep**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| 07:00 UTC | 2498 | 51.1% ±2.0 | 50.2% ±2.0 | 53.3% | 2476 | 32.8% | 0.06 | -0.14 |
| 08:00 UTC | 769 | 48.7% ±3.5 | 50.2% ±3.7 | 47.5% | 766 | 29.0% | -0.06 | -0.25 |
| 09:00 UTC | 287 | 47.5% ±5.8 | 49.2% ±6.1 | 44.9% | 287 | 24.0% | 0.07 | -0.15 |
| 10:00 UTC | 128 | 49.2% ±8.7 | 43.5% ±9.1 | 34.4% | 127 | 22.0% | -0.08 | -0.29 |
| 11:00 UTC | 154 | 45.8% ±7.9 | 44.5% ±8.6 | 28.6% | 154 | 19.5% | -0.12 | -0.34 |
| 12:00 UTC | 183 | 47.2% ±7.3 | 52.0% ±8.0 | 40.4% | 182 | 28.6% | 0.08 | -0.10 |

**Q10 — double sweep**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| single | 4005 | 50.0% ±1.6 | 49.8% ±1.6 | 49.4% | 3978 | 30.3% | 0.03 | -0.17 |
| double | 14 | 42.9% ±25.9 | 54.5% ±29.4 | 50.0% | 14 | 42.9% | -0.25 | -0.42 |

**News within 30 min of the London action**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| no news | 3742 | 50.2% ±1.6 | 49.8% ±1.7 | 49.1% | 3725 | 30.2% | 0.03 | -0.17 |
| news | 277 | 46.4% ±5.9 | 50.8% ±6.1 | 54.2% | 267 | 32.6% | 0.01 | -0.18 |

**Abnormal candle (> 3 ATR) during the sequence**

| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|---|
| normal | 3636 | 49.9% ±1.6 | 49.5% ±1.7 | 47.7% | 3634 | 28.6% | 0.03 | -0.18 |
| abnormal | 383 | 50.8% ±5.0 | 52.4% ±5.2 | 65.8% | 358 | 48.0% | 0.03 | -0.09 |

## 5. One day, candle by candle (EUR/USD)

**2025-12-15** — Asia 1.17286–1.17449 (16.3p). State after each closed candle, fed one at a time:

| candle (UTC) | open | high | low | close | state after close | what changed |
|---|---|---|---|---|---|---|
| 06:30 | 1.17354 | 1.17356 | 1.17309 | 1.17333 | ASIA_BUILDING |  |
| 06:45 | 1.17332 | 1.17365 | 1.17322 | 1.17354 | WAITING_FOR_SWEEP | → ASIA_LOCKED: A frozen 1.17286–1.17449; → WAITING_FOR_SWEEP: watching London |
| 07:00 | 1.17353 | 1.17382 | 1.17311 | 1.17324 | WAITING_FOR_SWEEP |  |
| 07:15 | 1.17324 | 1.17369 | 1.17314 | 1.17342 | WAITING_FOR_SWEEP |  |
| 07:30 | 1.17342 | 1.17363 | 1.17318 | 1.17322 | WAITING_FOR_SWEEP |  |
| 07:45 | 1.17322 | 1.17339 | 1.17279 | 1.17286 | SWEEP_CANDIDATE | → SWEEP_CANDIDATE: M? below Asia low 1.17286, 0.7p deep |
| 08:00 | 1.17285 | 1.17312 | 1.17265 | 1.17301 | WAITING_FOR_DISPLACEMENT | → RECLAIM_CONFIRMED: M closed back above 1.17286 → long; → WAITING_FOR_DISPLACEMENT: waiting for displacement |
| 08:15 | 1.17302 | 1.17346 | 1.17293 | 1.17332 | DISTRIBUTION_CONFIRMED | → DISTRIBUTION_CONFIRMED: D long (displacement), entry 1.173315 |
| 08:30 | 1.17330 | 1.17388 | 1.17326 | 1.17360 | DISTRIBUTION_CONFIRMED |  |
| 08:45 | 1.17359 | 1.17367 | 1.17312 | 1.17312 | DISTRIBUTION_CONFIRMED |  |
| 09:00 | 1.17312 | 1.17430 | 1.17306 | 1.17419 | DISTRIBUTION_CONFIRMED |  |
| 09:15 | 1.17420 | 1.17429 | 1.17387 | 1.17424 | DISTRIBUTION_CONFIRMED |  |

Final for the day: long from 1.17332, stop 1.17265, opposite boundary 1.17449 reached; +10 race: win; structural: win (1.77R).
