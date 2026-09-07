# EXIT-DURATION EXPERIMENT

| PAIR | CURRENT EXP | BEST EXIT EXP | CURRENT PF | BEST PF | CURRENT TP% | BEST TP% | RECOMMENDATION |
|---|---:|---|---:|---:|---:|---:|---|
| EUR_USD | 0.078 | 8H: 0.083 | 1.127 | 1.137 | 38.5% | 37.4% | KEEP_CURRENT |
| USD_JPY | 0.175 | 12H: 0.261 | 1.384 | 1.479 | 19.4% | 35.8% | INCONCLUSIVE |
| GBP_USD | 0.136 | 6H: 0.149 | 1.242 | 1.257 | 38.0% | 41.8% | INCONCLUSIVE |
| AUD_USD | 0.118 | 8H: 0.148 | 1.232 | 1.259 | 19.5% | 31.8% | INCONCLUSIVE |

BEST is descriptive, not an automatic recommendation.

## Plain-English conclusions

EUR/USD — KEEP_CURRENT. There is no existing timeout to extend. The tiny historical gain from imposing eight hours does not support a change. Its target payoff below +2R comes from the retained entry/barrier geometry, not premature time exits.

USD/JPY — INCONCLUSIVE after the uncertainty audit. Four hours is the shortest extension passing the initial historical screen; 12 hours is only the historical maximum. Longer holds improve aggregate expectancy in multiple years, though 2025 deteriorates and the short side does not share the gain. Only 25 time-exited trades drive the comparison. The four-hour gain has a descriptive 95% month-bootstrap interval of -0.061R to +0.145R, which includes no improvement. Retain the current exit and use four hours only as a candidate for a frozen forward-shadow comparison.

GBP/USD — INCONCLUSIVE; retain the current exit. Only five trades are affected. Three eventually reach their target and two hit the stop; the small pooled improvement is insufficient to infer a durable benefit. Six hours, eight hours, twelve hours and no timeout are identical in this cohort.

AUD/USD — INCONCLUSIVE for a longer finite exit; retain the current exit. The eight-hour historical gain disappears when 2026 is excluded. Removing the timeout raises full +2R target hits from 38 to 71, but also sends 21 previously positive time exits to -1R, reduces expectancy, and increases realized drawdown from 11.74R to 19R. More full targets do not imply a better strategy.

Portfolio recommendation: keep all deployed exit settings as they are. The only next candidate supported by this historical screen is USD/JPY CONTROL versus four hours in a separately frozen forward-shadow test, with both directions retained. Do not apply a blanket longer hold or remove all time exits. Longer overlapping positions, capital usage, correlation, and mark-to-market drawdown require a portfolio execution simulation before any rollout.

## EUR_USD: KEEP_CURRENT

| PAIR | MAX HOLD | N | TP% | SL% | TIME% | WR | AVG WIN R | AVG LOSS R | PF | EXP R | TOTAL R | MAX DD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EUR_USD | CONTROL | 356 | 38.5% | 61.5% | 0.0% | 38.5% | 1.801 | -1.000 | 1.127 | 0.078 | 27.735 | 12.729 |
| EUR_USD | 4H | 356 | 27.5% | 52.5% | 19.9% | 43.0% | 1.357 | -0.954 | 1.072 | 0.039 | 13.968 | 10.911 |
| EUR_USD | 6H | 356 | 34.8% | 58.1% | 7.0% | 40.4% | 1.649 | -0.988 | 1.134 | 0.079 | 28.023 | 11.292 |
| EUR_USD | 8H | 356 | 37.4% | 60.4% | 2.2% | 39.3% | 1.749 | -0.997 | 1.137 | 0.083 | 29.497 | 12.336 |
| EUR_USD | 12H | 356 | 37.9% | 61.0% | 1.1% | 39.0% | 1.771 | -1.000 | 1.134 | 0.082 | 29.158 | 12.336 |
| EUR_USD | NO_TIMEOUT | 356 | 38.5% | 61.5% | 0.0% | 38.5% | 1.801 | -1.000 | 1.127 | 0.078 | 27.735 | 12.729 |

Historical maximum: 8H. Evidence-supported selection: CONTROL.

### CONTROL

TP 137 (38.5%), of which full +2R=0; SL 219; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=3.225 hours; LONG/SHORT EXP=0.080/0.076R; spread avg/median=1.558/1.600 pips; midpoint winner to executable loss=5; censored=0.

2023: N=106, PF=1.015, EXP=0.010R, delta=0.000R; 2024: N=95, PF=1.287, EXP=0.166R, delta=0.000R; 2025: N=95, PF=1.065, EXP=0.041R, delta=0.000R; 2026: N=60, PF=1.195, EXP=0.117R, delta=0.000R.

Compared with CONTROL: changed 0 trades; paired gain 0.000R/trade; extra targets 0; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Baseline. Paired month-bootstrap 95% interval for gain: [0.000, 0.000]R. Matched N=356; matched control/variant EXP=0.078/0.078R.

### 4H

TP 98 (27.5%), of which full +2R=0; SL 187; TIME 71; average TIME=0.350R; median trade=-1.000R; holding=2.528 hours; LONG/SHORT EXP=0.024/0.055R; spread avg/median=1.558/1.600 pips; midpoint winner to executable loss=4; censored=0.

2023: N=106, PF=1.041, EXP=0.021R, delta=0.011R; 2024: N=95, PF=1.264, EXP=0.140R, delta=-0.026R; 2025: N=95, PF=0.952, EXP=-0.028R, delta=-0.070R; 2026: N=60, PF=1.034, EXP=0.019R, delta=-0.098R.

Compared with CONTROL: changed 71 trades; paired gain -0.039R/trade; extra targets -39; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Support checks: SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE. Paired month-bootstrap 95% interval for gain: [-0.094, 0.014]R. Matched N=356; matched control/variant EXP=0.078/0.039R.

### 6H

TP 124 (34.8%), of which full +2R=0; SL 207; TIME 25; average TIME=0.483R; median trade=-1.000R; holding=2.840 hours; LONG/SHORT EXP=0.062/0.096R; spread avg/median=1.558/1.600 pips; midpoint winner to executable loss=5; censored=0.

2023: N=106, PF=1.051, EXP=0.031R, delta=0.021R; 2024: N=95, PF=1.327, EXP=0.182R, delta=0.016R; 2025: N=95, PF=1.032, EXP=0.020R, delta=-0.021R; 2026: N=60, PF=1.162, EXP=0.093R, delta=-0.024R.

Compared with CONTROL: changed 25 trades; paired gain 0.001R/trade; extra targets -13; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Support checks: SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE. Paired month-bootstrap 95% interval for gain: [-0.034, 0.033]R. Matched N=356; matched control/variant EXP=0.078/0.079R.

### 8H

TP 133 (37.4%), of which full +2R=0; SL 215; TIME 8; average TIME=0.644R; median trade=-1.000R; holding=2.944 hours; LONG/SHORT EXP=0.077/0.089R; spread avg/median=1.558/1.600 pips; midpoint winner to executable loss=5; censored=0.

2023: N=106, PF=1.037, EXP=0.023R, delta=0.013R; 2024: N=95, PF=1.287, EXP=0.166R, delta=0.000R; 2025: N=95, PF=1.062, EXP=0.039R, delta=-0.002R; 2026: N=60, PF=1.215, EXP=0.127R, delta=0.010R.

Compared with CONTROL: changed 8 trades; paired gain 0.005R/trade; extra targets -4; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY. Paired month-bootstrap 95% interval for gain: [-0.013, 0.026]R. Matched N=356; matched control/variant EXP=0.078/0.083R.

### 12H

TP 135 (37.9%), of which full +2R=0; SL 217; TIME 4; average TIME=0.776R; median trade=-1.000R; holding=3.011 hours; LONG/SHORT EXP=0.076/0.088R; spread avg/median=1.558/1.600 pips; midpoint winner to executable loss=5; censored=0.

2023: N=106, PF=1.037, EXP=0.023R, delta=0.013R; 2024: N=95, PF=1.287, EXP=0.166R, delta=0.000R; 2025: N=95, PF=1.065, EXP=0.041R, delta=0.000R; 2026: N=60, PF=1.195, EXP=0.117R, delta=0.000R.

Compared with CONTROL: changed 4 trades; paired gain 0.004R/trade; extra targets -2; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE. Paired month-bootstrap 95% interval for gain: [-0.005, 0.015]R. Matched N=356; matched control/variant EXP=0.078/0.082R.

### NO_TIMEOUT

TP 137 (38.5%), of which full +2R=0; SL 219; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=3.225 hours; LONG/SHORT EXP=0.080/0.076R; spread avg/median=1.558/1.600 pips; midpoint winner to executable loss=5; censored=0.

2023: N=106, PF=1.015, EXP=0.010R, delta=0.000R; 2024: N=95, PF=1.287, EXP=0.166R, delta=0.000R; 2025: N=95, PF=1.065, EXP=0.041R, delta=0.000R; 2026: N=60, PF=1.195, EXP=0.117R, delta=0.000R.

Compared with CONTROL: changed 0 trades; paired gain 0.000R/trade; extra targets 0; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE. Paired month-bootstrap 95% interval for gain: [0.000, 0.000]R. Matched N=356; matched control/variant EXP=0.078/0.078R.

## USD_JPY: INCONCLUSIVE

| PAIR | MAX HOLD | N | TP% | SL% | TIME% | WR | AVG WIN R | AVG LOSS R | PF | EXP R | TOTAL R | MAX DD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USD_JPY | CONTROL | 67 | 19.4% | 43.3% | 37.3% | 46.3% | 1.365 | -0.849 | 1.384 | 0.175 | 11.738 | 7.262 |
| USD_JPY | 4H | 67 | 26.9% | 44.8% | 28.4% | 44.8% | 1.551 | -0.864 | 1.456 | 0.218 | 14.573 | 6.207 |
| USD_JPY | 6H | 67 | 31.3% | 47.8% | 20.9% | 44.8% | 1.670 | -0.914 | 1.481 | 0.243 | 16.267 | 5.858 |
| USD_JPY | 8H | 67 | 34.3% | 49.3% | 16.4% | 46.3% | 1.668 | -0.960 | 1.497 | 0.256 | 17.165 | 5.000 |
| USD_JPY | 12H | 67 | 35.8% | 53.7% | 10.4% | 44.8% | 1.797 | -0.985 | 1.479 | 0.261 | 17.460 | 7.186 |
| USD_JPY | NO_TIMEOUT | 67 | 41.8% | 58.2% | 0.0% | 41.8% | 2.000 | -1.000 | 1.436 | 0.254 | 17.000 | 7.000 |

Historical maximum: 12H. Evidence-supported selection: CONTROL.

### CONTROL

TP 13 (19.4%), of which full +2R=13; SL 29; TIME 25; average TIME=0.590R; median trade=-0.188R; holding=2.209 hours; LONG/SHORT EXP=0.194/0.147R; spread avg/median=1.625/1.600 pips; midpoint winner to executable loss=2; censored=0.

2023: N=20, PF=1.010, EXP=0.006R, delta=0.000R; 2024: N=14, PF=1.309, EXP=0.137R, delta=0.000R; 2025: N=24, PF=1.682, EXP=0.256R, delta=0.000R; 2026: N=9, PF=2.064, EXP=0.394R, delta=0.000R.

Compared with CONTROL: changed 0 trades; paired gain 0.000R/trade; extra targets 0; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Baseline. Paired month-bootstrap 95% interval for gain: [0.000, 0.000]R. Matched N=67; matched control/variant EXP=0.175/0.175R.

### 4H

TP 18 (26.9%), of which full +2R=18; SL 30; TIME 19; average TIME=0.451R; median trade=-0.216R; holding=2.582 hours; LONG/SHORT EXP=0.270/0.140R; spread avg/median=1.625/1.600 pips; midpoint winner to executable loss=4; censored=0.

2023: N=20, PF=1.082, EXP=0.049R, delta=0.043R; 2024: N=14, PF=1.683, EXP=0.315R, delta=0.178R; 2025: N=24, PF=1.400, EXP=0.175R, delta=-0.081R; 2026: N=9, PF=2.658, EXP=0.553R, delta=0.158R.

Compared with CONTROL: changed 25 trades; paired gain 0.042R/trade; extra targets 5; control TIME exits becoming TP/SL=5/1; positive control TIME exits becoming SL=1. Support checks: all passed. Paired month-bootstrap 95% interval for gain: [-0.061, 0.145]R. Matched N=67; matched control/variant EXP=0.175/0.218R.

### 6H

TP 21 (31.3%), of which full +2R=21; SL 32; TIME 14; average TIME=0.448R; median trade=-0.508R; holding=3.119 hours; LONG/SHORT EXP=0.311/0.141R; spread avg/median=1.625/1.600 pips; midpoint winner to executable loss=2; censored=0.

2023: N=20, PF=1.245, EXP=0.147R, delta=0.141R; 2024: N=14, PF=1.608, EXP=0.305R, delta=0.167R; 2025: N=24, PF=1.346, EXP=0.163R, delta=-0.093R; 2026: N=9, PF=2.467, EXP=0.572R, delta=0.177R.

Compared with CONTROL: changed 25 trades; paired gain 0.068R/trade; extra targets 8; control TIME exits becoming TP/SL=8/3; positive control TIME exits becoming SL=1. Support checks: all passed. Paired month-bootstrap 95% interval for gain: [-0.059, 0.197]R. Matched N=67; matched control/variant EXP=0.175/0.243R.

### 8H

TP 23 (34.3%), of which full +2R=23; SL 33; TIME 11; average TIME=0.379R; median trade=-0.621R; holding=3.507 hours; LONG/SHORT EXP=0.342/0.129R; spread avg/median=1.625/1.600 pips; midpoint winner to executable loss=2; censored=0.

2023: N=20, PF=1.252, EXP=0.151R, delta=0.145R; 2024: N=14, PF=1.691, EXP=0.350R, delta=0.213R; 2025: N=24, PF=1.391, EXP=0.187R, delta=-0.070R; 2026: N=9, PF=2.190, EXP=0.529R, delta=0.135R.

Compared with CONTROL: changed 25 trades; paired gain 0.081R/trade; extra targets 10; control TIME exits becoming TP/SL=10/4; positive control TIME exits becoming SL=1. Support checks: all passed. Paired month-bootstrap 95% interval for gain: [-0.069, 0.238]R. Matched N=67; matched control/variant EXP=0.175/0.256R.

### 12H

TP 24 (35.8%), of which full +2R=24; SL 36; TIME 7; average TIME=0.780R; median trade=-1.000R; holding=4.119 hours; LONG/SHORT EXP=0.385/0.077R; spread avg/median=1.625/1.600 pips; midpoint winner to executable loss=1; censored=0.

2023: N=20, PF=1.233, EXP=0.140R, delta=0.134R; 2024: N=14, PF=1.500, EXP=0.286R, delta=0.148R; 2025: N=24, PF=1.443, EXP=0.230R, delta=-0.026R; 2026: N=9, PF=2.288, EXP=0.573R, delta=0.178R.

Compared with CONTROL: changed 25 trades; paired gain 0.085R/trade; extra targets 11; control TIME exits becoming TP/SL=11/7; positive control TIME exits becoming SL=1. Support checks: all passed. Paired month-bootstrap 95% interval for gain: [-0.076, 0.261]R. Matched N=67; matched control/variant EXP=0.175/0.261R.

### NO_TIMEOUT

TP 28 (41.8%), of which full +2R=28; SL 39; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=4.716 hours; LONG/SHORT EXP=0.425/0.000R; spread avg/median=1.625/1.600 pips; midpoint winner to executable loss=1; censored=0.

2023: N=20, PF=1.077, EXP=0.050R, delta=0.044R; 2024: N=14, PF=1.500, EXP=0.286R, delta=0.148R; 2025: N=24, PF=1.429, EXP=0.250R, delta=-0.006R; 2026: N=9, PF=2.500, EXP=0.667R, delta=0.272R.

Compared with CONTROL: changed 25 trades; paired gain 0.079R/trade; extra targets 15; control TIME exits becoming TP/SL=15/10; positive control TIME exits becoming SL=4. Support checks: all passed. Paired month-bootstrap 95% interval for gain: [-0.118, 0.279]R. Matched N=67; matched control/variant EXP=0.175/0.254R.

## GBP_USD: INCONCLUSIVE

| PAIR | MAX HOLD | N | TP% | SL% | TIME% | WR | AVG WIN R | AVG LOSS R | PF | EXP R | TOTAL R | MAX DD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| GBP_USD | CONTROL | 79 | 38.0% | 55.7% | 6.3% | 43.0% | 1.621 | -0.986 | 1.242 | 0.136 | 10.754 | 9.239 |
| GBP_USD | 4H | 79 | 38.0% | 57.0% | 5.1% | 41.8% | 1.685 | -0.989 | 1.223 | 0.128 | 10.118 | 9.021 |
| GBP_USD | 6H | 79 | 41.8% | 58.2% | 0.0% | 41.8% | 1.752 | -1.000 | 1.257 | 0.149 | 11.805 | 9.548 |
| GBP_USD | 8H | 79 | 41.8% | 58.2% | 0.0% | 41.8% | 1.752 | -1.000 | 1.257 | 0.149 | 11.805 | 9.548 |
| GBP_USD | 12H | 79 | 41.8% | 58.2% | 0.0% | 41.8% | 1.752 | -1.000 | 1.257 | 0.149 | 11.805 | 9.548 |
| GBP_USD | NO_TIMEOUT | 79 | 41.8% | 58.2% | 0.0% | 41.8% | 1.752 | -1.000 | 1.257 | 0.149 | 11.805 | 9.548 |

Historical maximum: 6H. Evidence-supported selection: CONTROL.

### CONTROL

TP 30 (38.0%), of which full +2R=0; SL 44; TIME 5; average TIME=0.441R; median trade=-1.000R; holding=1.475 hours; LONG/SHORT EXP=0.156/0.112R; spread avg/median=1.891/1.900 pips; midpoint winner to executable loss=1; censored=0.

2025: N=46, PF=1.349, EXP=0.193R, delta=0.000R; 2026: N=33, PF=1.100, EXP=0.057R, delta=0.000R.

Compared with CONTROL: changed 0 trades; paired gain 0.000R/trade; extra targets 0; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Baseline. Paired month-bootstrap 95% interval for gain: [0.000, 0.000]R. Matched N=79; matched control/variant EXP=0.136/0.136R.

### 4H

TP 30 (38.0%), of which full +2R=0; SL 45; TIME 4; average TIME=0.643R; median trade=-1.000R; holding=1.538 hours; LONG/SHORT EXP=0.141/0.113R; spread avg/median=1.891/1.900 pips; midpoint winner to executable loss=1; censored=0.

2025: N=46, PF=1.334, EXP=0.189R, delta=-0.004R; 2026: N=33, PF=1.074, EXP=0.044R, delta=-0.014R.

Compared with CONTROL: changed 5 trades; paired gain -0.008R/trade; extra targets 0; control TIME exits becoming TP/SL=0/1; positive control TIME exits becoming SL=0. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE. Paired month-bootstrap 95% interval for gain: [-0.045, 0.025]R. Matched N=79; matched control/variant EXP=0.136/0.128R.

### 6H

TP 33 (41.8%), of which full +2R=0; SL 46; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=1.582 hours; LONG/SHORT EXP=0.155/0.142R; spread avg/median=1.891/1.900 pips; midpoint winner to executable loss=1; censored=0.

2025: N=46, PF=1.362, EXP=0.205R, delta=0.012R; 2026: N=33, PF=1.119, EXP=0.072R, delta=0.015R.

Compared with CONTROL: changed 5 trades; paired gain 0.013R/trade; extra targets 3; control TIME exits becoming TP/SL=3/2; positive control TIME exits becoming SL=1. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN. Paired month-bootstrap 95% interval for gain: [-0.051, 0.076]R. Matched N=79; matched control/variant EXP=0.136/0.149R.

### 8H

TP 33 (41.8%), of which full +2R=0; SL 46; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=1.582 hours; LONG/SHORT EXP=0.155/0.142R; spread avg/median=1.891/1.900 pips; midpoint winner to executable loss=1; censored=0.

2025: N=46, PF=1.362, EXP=0.205R, delta=0.012R; 2026: N=33, PF=1.119, EXP=0.072R, delta=0.015R.

Compared with CONTROL: changed 5 trades; paired gain 0.013R/trade; extra targets 3; control TIME exits becoming TP/SL=3/2; positive control TIME exits becoming SL=1. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN. Paired month-bootstrap 95% interval for gain: [-0.051, 0.076]R. Matched N=79; matched control/variant EXP=0.136/0.149R.

### 12H

TP 33 (41.8%), of which full +2R=0; SL 46; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=1.582 hours; LONG/SHORT EXP=0.155/0.142R; spread avg/median=1.891/1.900 pips; midpoint winner to executable loss=1; censored=0.

2025: N=46, PF=1.362, EXP=0.205R, delta=0.012R; 2026: N=33, PF=1.119, EXP=0.072R, delta=0.015R.

Compared with CONTROL: changed 5 trades; paired gain 0.013R/trade; extra targets 3; control TIME exits becoming TP/SL=3/2; positive control TIME exits becoming SL=1. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN. Paired month-bootstrap 95% interval for gain: [-0.051, 0.076]R. Matched N=79; matched control/variant EXP=0.136/0.149R.

### NO_TIMEOUT

TP 33 (41.8%), of which full +2R=0; SL 46; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=1.582 hours; LONG/SHORT EXP=0.155/0.142R; spread avg/median=1.891/1.900 pips; midpoint winner to executable loss=1; censored=0.

2025: N=46, PF=1.362, EXP=0.205R, delta=0.012R; 2026: N=33, PF=1.119, EXP=0.072R, delta=0.015R.

Compared with CONTROL: changed 5 trades; paired gain 0.013R/trade; extra targets 3; control TIME exits becoming TP/SL=3/2; positive control TIME exits becoming SL=1. Support checks: FEW_AFFECTED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN. Paired month-bootstrap 95% interval for gain: [-0.051, 0.076]R. Matched N=79; matched control/variant EXP=0.136/0.149R.

## AUD_USD: INCONCLUSIVE

| PAIR | MAX HOLD | N | TP% | SL% | TIME% | WR | AVG WIN R | AVG LOSS R | PF | EXP R | TOTAL R | MAX DD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| AUD_USD | CONTROL | 195 | 19.5% | 48.7% | 31.8% | 45.6% | 1.378 | -0.939 | 1.232 | 0.118 | 23.068 | 11.742 |
| AUD_USD | 4H | 195 | 24.6% | 52.8% | 22.6% | 42.6% | 1.556 | -0.950 | 1.214 | 0.117 | 22.725 | 14.945 |
| AUD_USD | 6H | 195 | 29.7% | 55.4% | 14.9% | 42.1% | 1.676 | -0.975 | 1.247 | 0.140 | 27.217 | 13.670 |
| AUD_USD | 8H | 195 | 31.8% | 56.9% | 11.3% | 41.5% | 1.738 | -0.981 | 1.259 | 0.148 | 28.947 | 14.611 |
| AUD_USD | 12H | 193 | 32.6% | 58.5% | 8.8% | 39.9% | 1.783 | -0.982 | 1.205 | 0.121 | 23.358 | 13.873 |
| AUD_USD | NO_TIMEOUT | 195 | 36.4% | 63.6% | 0.0% | 36.4% | 2.000 | -1.000 | 1.145 | 0.092 | 18.000 | 19.000 |

Historical maximum: 8H. Evidence-supported selection: CONTROL.

### CONTROL

TP 38 (19.5%), of which full +2R=38; SL 95; TIME 62; average TIME=0.679R; median trade=-0.650R; holding=2.179 hours; LONG/SHORT EXP=0.118/n/aR; spread avg/median=1.279/1.300 pips; midpoint winner to executable loss=7; censored=0.

2023: N=58, PF=1.013, EXP=0.008R, delta=0.000R; 2024: N=57, PF=1.336, EXP=0.166R, delta=0.000R; 2025: N=40, PF=0.894, EXP=-0.057R, delta=0.000R; 2026: N=40, PF=2.044, EXP=0.386R, delta=0.000R.

Compared with CONTROL: changed 0 trades; paired gain 0.000R/trade; extra targets 0; control TIME exits becoming TP/SL=0/0; positive control TIME exits becoming SL=0. Baseline. Paired month-bootstrap 95% interval for gain: [0.000, 0.000]R. Matched N=195; matched control/variant EXP=0.118/0.118R.

### 4H

TP 48 (24.6%), of which full +2R=48; SL 103; TIME 44; average TIME=0.676R; median trade=-1.000R; holding=2.497 hours; LONG/SHORT EXP=0.117/n/aR; spread avg/median=1.279/1.300 pips; midpoint winner to executable loss=4; censored=0.

2023: N=58, PF=1.002, EXP=0.001R, delta=-0.006R; 2024: N=57, PF=1.232, EXP=0.126R, delta=-0.040R; 2025: N=40, PF=0.769, EXP=-0.144R, delta=-0.087R; 2026: N=40, PF=2.502, EXP=0.531R, delta=0.144R.

Compared with CONTROL: changed 62 trades; paired gain -0.002R/trade; extra targets 10; control TIME exits becoming TP/SL=10/8; positive control TIME exits becoming SL=4. Support checks: SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE, DRAWDOWN_DETERIORATION. Paired month-bootstrap 95% interval for gain: [-0.058, 0.055]R. Matched N=195; matched control/variant EXP=0.118/0.117R.

### 6H

TP 58 (29.7%), of which full +2R=58; SL 108; TIME 29; average TIME=0.663R; median trade=-1.000R; holding=2.918 hours; LONG/SHORT EXP=0.140/n/aR; spread avg/median=1.279/1.300 pips; midpoint winner to executable loss=4; censored=0.

2023: N=58, PF=0.979, EXP=-0.014R, delta=-0.021R; 2024: N=57, PF=1.293, EXP=0.167R, delta=0.001R; 2025: N=40, PF=0.896, EXP=-0.063R, delta=-0.006R; 2026: N=40, PF=2.368, EXP=0.526R, delta=0.140R.

Compared with CONTROL: changed 62 trades; paired gain 0.021R/trade; extra targets 20; control TIME exits becoming TP/SL=20/13; positive control TIME exits becoming SL=8. Support checks: SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE. Paired month-bootstrap 95% interval for gain: [-0.034, 0.079]R. Matched N=195; matched control/variant EXP=0.118/0.140R.

### 8H

TP 62 (31.8%), of which full +2R=62; SL 111; TIME 22; average TIME=0.725R; median trade=-1.000R; holding=3.195 hours; LONG/SHORT EXP=0.148/n/aR; spread avg/median=1.279/1.300 pips; midpoint winner to executable loss=3; censored=0.

2023: N=58, PF=0.996, EXP=-0.003R, delta=-0.011R; 2024: N=57, PF=1.311, EXP=0.176R, delta=0.011R; 2025: N=40, PF=0.828, EXP=-0.109R, delta=-0.052R; 2026: N=40, PF=2.452, EXP=0.585R, delta=0.199R.

Compared with CONTROL: changed 62 trades; paired gain 0.030R/trade; extra targets 24; control TIME exits becoming TP/SL=24/16; positive control TIME exits becoming SL=11. Support checks: SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE, DRAWDOWN_DETERIORATION. Paired month-bootstrap 95% interval for gain: [-0.034, 0.099]R. Matched N=195; matched control/variant EXP=0.118/0.148R.

### 12H

TP 63 (32.6%), of which full +2R=63; SL 113; TIME 17; average TIME=0.609R; median trade=-1.000R; holding=3.544 hours; LONG/SHORT EXP=0.121/n/aR; spread avg/median=1.279/1.300 pips; midpoint winner to executable loss=8; censored=2.

2023: N=58, PF=0.983, EXP=-0.011R, delta=-0.019R; 2024: N=57, PF=1.240, EXP=0.142R, delta=-0.024R; 2025: N=39, PF=0.829, EXP=-0.110R, delta=-0.066R; 2026: N=39, PF=2.185, EXP=0.517R, delta=0.117R.

Compared with CONTROL: changed 60 trades; paired gain -0.002R/trade; extra targets 25; control TIME exits becoming TP/SL=25/18; positive control TIME exits becoming SL=13. Support checks: CENSORED_TRADES, SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE, DRAWDOWN_DETERIORATION. Paired month-bootstrap 95% interval for gain: [-0.069, 0.068]R. Matched N=193; matched control/variant EXP=0.123/0.121R.

### NO_TIMEOUT

TP 71 (36.4%), of which full +2R=71; SL 124; TIME 0; average TIME=n/aR; median trade=-1.000R; holding=4.574 hours; LONG/SHORT EXP=0.092/n/aR; spread avg/median=1.279/1.300 pips; midpoint winner to executable loss=6; censored=0.

2023: N=58, PF=0.900, EXP=-0.069R, delta=-0.077R; 2024: N=57, PF=1.353, EXP=0.211R, delta=0.045R; 2025: N=40, PF=0.667, EXP=-0.250R, delta=-0.193R; 2026: N=40, PF=2.000, EXP=0.500R, delta=0.114R.

Compared with CONTROL: changed 62 trades; paired gain -0.026R/trade; extra targets 33; control TIME exits becoming TP/SL=33/29; positive control TIME exits becoming SL=21. Support checks: SMALL_EXPECTANCY_GAIN, SMALL_PF_GAIN, YEAR_INSTABILITY, YEAR_DEPENDENCE, DRAWDOWN_DETERIORATION. Paired month-bootstrap 95% interval for gain: [-0.115, 0.064]R. Matched N=195; matched control/variant EXP=0.118/0.092R.

## Methodology and limits

- Entries, their direction, ATR and price geometry are the exact saved prior cohort; independent legs remain even if longer holds overlap. No new signals are admitted or removed. This isolates exits, not executable portfolio position limits.
- EURUSD CONTROL already has no timeout. Other CONTROL durations are three hours (3 H1 bars; GBPUSD 6 M30 bars). GBPUSD 4/6/8/12 hours map to 8/12/16/24 future M30 bars.
- Same original OANDA historical windows were re-fetched and cached, with all saved midpoint and executable control trades reproduced. The original raw candle bytes were not retained, so byte-for-byte equality to the earlier pull cannot be proved.
- USDJPY/AUDUSD freeze ATR and place barriers around executable entry. EURUSD/GBPUSD retain frozen absolute midpoint barriers, so their executable TP can be below +2R. Both target hits and full +2R hits are reported; changing these barriers would confound this experiment.
- Results inherit original EURUSD Pine parity caveat (142 vs supplied 146 winners), inferred GBPUSD date boundary, and previously inspected historical sample. This is not untouched out-of-sample validation.
- Uses original strategy-timeframe stop-first OHLC semantics and exact barrier fills. No tick latency, gap slippage, financing or commissions were added. Holding hours use bar-close exit timestamps and can overstate within-bar touch time. Maximum drawdown is realized closed-trade R with simultaneous exits aggregated, not mark-to-market drawdown.
- Finite timeouts require consecutive scheduled bars as in the original resolver. Missing future candles and unresolved no-timeout trades are censored, never assigned a fabricated outcome. Support is withheld for censored variants; paired comparisons use common closed trades.
- Historical spread is embedded in executable quotes, never deducted twice. Per-variant midpoint replays serve only to count cost-induced winner-to-loser changes.
- Support policy was fixed before duration results: at least 50 trades, 20 affected trades, +0.03R/trade and +0.05 PF, at least two improving material years and two-thirds of material years improving, positive leave-one-year-out gain, no more than 2R extra realized drawdown, and no censoring. These are conservative decision heuristics, not statistical proof. No parameter search beyond the six requested variants.
- After the initial historical screen, an additional paired month-cluster bootstrap uncertainty audit was added (5000 draws, fixed seed). It was not predeclared. Final support is withheld where its 95% interval includes zero, even when the initial screen passes. This stricter evidential review changes no duration or strategy parameter. No interval excludes zero here; multiplicity-adjusted evidence would be weaker still.

Per-variant classifications and all metrics are in variant-summary.csv; full year-level metrics, paired changes and bootstrap intervals are in RESULTS.json.

No production strategies, risk settings, positions or deployments were changed. NZDUSD was not evaluated.
