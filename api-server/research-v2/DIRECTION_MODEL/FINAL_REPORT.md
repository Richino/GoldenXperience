# DIRECTION_MODEL — Final report

Final verdict: **NO_DIRECTION_EDGE**

Question: once EUR/USD is (about to be) making a meaningful move, is there enough information BEFORE the move to predict UP vs DOWN?

## Headline
- **BEST HORIZON:** 15m
- **BEST MODEL:** gradient-boosted trees (logistic ≈ same; no RF/NN warranted — see gate below)
- **DIRECTION ACCURACY:** 0.5180 (balanced 0.5176) on the untouched oracle holdout
- **BASELINE ACCURACY:** 0.5021 (best of always-up/down, prev-return, trend, momentum, majority)
- **INCREMENTAL EDGE:** +0.0159 accuracy / +0.0176 balanced-accuracy vs coin flip
- **BEST CONFIDENCE BUCKET:** 0.5-0.55 (acc 0.518, n=4689)
- **ORACLE-MOVE DIRECTION ACCURACY:** 0.5180 (perfect move foresight)
- **MOVE_MODEL-CONDITIONAL DIRECTION ACCURACY:** 0.5104 (move_prob≥0.60, n=3323)
- **WALK-FORWARD FOLDS BEATING BASELINE:** 6/8 (GBT AUC > 0.52)

## Oracle walk-forward by horizon (a move really happened)

| Horizon | Mean GBT acc | Mean GBT bal-acc | Mean GBT AUC | Mean best-baseline acc |
|---|---:|---:|---:|---:|
| 15m | 0.5162 | 0.5159 | 0.5249 | 0.5081 |
| 30m | 0.5118 | 0.5115 | 0.5189 | 0.5090 |
| 60m | 0.5079 | 0.5070 | 0.5130 | 0.5128 |
| 120m | 0.5031 | 0.5028 | 0.5065 | 0.5132 |

## Oracle final untouched holdout

| Horizon | N | GBT acc | GBT bal-acc | GBT AUC | Best baseline acc | GBT − baseline |
|---|---:|---:|---:|---:|---:|---:|
| 15m | 5415 | 0.5180 | 0.5176 | 0.5200 | 0.5021 | +0.0159 |
| 30m | 6047 | 0.5146 | 0.5134 | 0.5199 | 0.5107 | +0.0040 |
| 60m | 5712 | 0.5067 | 0.5064 | 0.5121 | 0.5161 | -0.0095 |
| 120m | 6311 | 0.5067 | 0.5083 | 0.5212 | 0.5158 | -0.0090 |

AUC ≈ 0.50 and balanced accuracy ≈ 0.50 mean the model cannot tell UP from DOWN better than a coin flip, regardless of raw accuracy (which just tracks the class skew).

## The critical oracle test
Even with PERFECT foreknowledge that a meaningful move was coming (oracle selection on ground-truth moves), the best horizon reaches only balanced accuracy 0.5176 / AUC 0.5200 on the untouched holdout. This is indistinguishable from chance.

## Does stronger MOVE confidence make direction easier? (best horizon)

| MOVE prob ≥ | N | Dir accuracy | Balanced acc | AUC |
|---:|---:|---:|---:|---:|
| 0.5 | 5011 | 0.5071 | 0.5081 | 0.5014 |
| 0.55 | 4183 | 0.5104 | 0.5113 | 0.5065 |
| 0.6 | 3323 | 0.5104 | 0.5109 | 0.5075 |
| 0.65 | 2583 | 0.5130 | 0.5136 | 0.5145 |
| 0.7 | 1915 | 0.5091 | 0.5095 | 0.5134 |

Selecting only the strongest MOVE_MODEL opportunities does NOT improve directional accuracy — consistent with MOVE selection NOT being the bottleneck.

## Confidence calibration (best horizon, oracle holdout)

| Confidence bucket | N | Dir accuracy | UP-call accuracy | DOWN-call accuracy |
|---|---:|---:|---:|---:|
| 0.5-0.55 | 4689 | 0.5176 | 0.5194 | 0.5163 |
| 0.55-0.6 | 614 | 0.5163 | 0.5118 | 0.5194 |
| 0.6-0.65 | 77 | 0.4935 | 0.4167 | 0.6207 |
| 0.65-0.7 | 23 | 0.6522 | 0.7500 | 0.0000 |
| 0.7-1.01 | 12 | 0.6667 | 0.6667 | NaN |

**Anti-calibration flag: higher-confidence buckets do NOT achieve higher directional accuracy — model confidence is not trustworthy.**

## Feature ablation (which groups carry directional information)
See ABLATION_RESULTS.csv. Positive delta on removal = the group was noise/harmful. Groups tested: trend, momentum, structure, volatility, multitf, time, news, liquidity, move_conf.

## Model escalation
Logistic and GBT were run. Neither simpler model beat chance out-of-sample, so per protocol NO random forest or neural network was pursued — a larger model cannot recover directional information that is absent from the features.

## Judgment
**No directional edge.** Even on oracle-known meaningful moves, UP/DOWN is not predictable above naive baselines out-of-sample; the signal does not survive walk-forward/holdout and confidence is not calibrated. Crucially, since the oracle test also fails, MOVE_MODEL selection is NOT the bottleneck — the directional information simply is not present in the current price/vol/structure/time/news features. This matches the repository's prior EUR/USD direction nulls. Do not connect to paper/production; a bigger model will not fix missing information — only a genuinely new exogenous directional signal could.

MOVE_MODEL was used read-only and left frozen. No paper-trading or production connection.
