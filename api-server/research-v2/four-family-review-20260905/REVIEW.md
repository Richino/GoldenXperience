# Four-family trading review — September 5, 2026

The priority is to repair the performance measurement and adaptive evidence before tuning entries. None of the four families has a demonstrated executable edge in the evidence reviewed here. EMA looks strongest in the pooled ledger, but that conclusion does not survive separating broker outcomes from simulated outcomes or putting results on comparable risk units.

This is a research-only review. No strategy, execution policy, risk gate, database row, deployment, or frozen V1 configuration was changed. The local checkout was pulled first and was already up to date; pre-existing uncommitted changes remain in place. Local code findings therefore describe this checkout, not a verified deployed build.

Database reads on September 5 at approximately 18:08–18:13 UTC used a READ ONLY transaction. The ledger contained 230 closed records: 201 attributed to these families and 29 legacy records excluded from family results. The family cohort covers August 19–September 4, only 13 distinct entry days. Of the 201 records, 108 have result_basis=broker and 93 have result_basis=model. A submitted order does not establish that its journal close was reconciled from broker data.

| Family | All ledger trades | Stored net R/trade | Stored total R | Broker-based trades | Broker-based stored R/trade |
|---|---:|---:|---:|---:|---:|
| EMA | 67 | +0.124 | +8.317 | 34 | -0.110 |
| Breakout | 38 | -0.137 | -5.212 | 25 | -0.146 |
| Momentum | 80 | -0.186 | -14.880 | 38 | -0.178 |
| Mean reversion | 16 | -0.034 | -0.551 | 11 | -0.048 |

These are the database's recorded units, not comparable estimates of one unit of actual position risk. They should not be interpreted as a portfolio return or a validated strategy ranking. All four broker-based subsets have negative stored totals. EMA's 33 model-based records contribute +12.049R, while its 34 broker-based records contribute -3.732R. Different opportunities populate these subsets; the difference alone does not prove that execution caused the losses.

**The highest-priority finding: inconsistent R denominators.**

The code in `api-server/src/practice-execution.ts:69` caps requested units when building the broker order. It preserves requested and submitted units in the order payload but does not update the trade's planned risk denominator. In `api-server/src/paper-cycle.ts:784`, broker R is realized broker cash P&L divided by `nominal_risk_amount`. Model R instead measures price movement divided by the original stop distance. The adaptive evidence loader aggregates both measurements together and also adds shadow results (`api-server/src/adaptive-engine.ts:536`).

81 of the 108 broker-based records have submitted units below calculated units. This is not just a theoretical concern:

- EMA trade #214 requested 1,466,160 units but submitted 248,620. Its recorded entry/exit geometry is exactly +2R, while the journal stores +0.338R.
- EMA trade #196 requested 1,716,902 units but submitted 347,663. It hit its recorded stop, a -1R price move, while the journal stores -0.197R.

Reducing exposure is valid risk management. Combining a return measured against planned exposure with a model return measured against actual stop risk is invalid for estimating strategy expectancy. It also makes reduced broker losses appear smaller than model losses, which can influence the selector.

As a sensitivity check, rescaling broker R by calculated units / submitted units changes combined EMA expectancy from +0.124 to approximately -0.066R/trade. Independently calculating R from recorded entry, stop, and exit gives -0.062R/trade. Both checks make the apparent EMA edge disappear. These are diagnostic proxies, not repaired broker performance: exact repair needs actual entry fills, filled units, entry-time currency conversion, and confirmed closes.

Keep distinct fields for broker cash P&L, return relative to planned risk, return relative to actual initial position risk, and model/shadow R. Preserve original records and add corrected/versioned evidence. Reconcile the 65 model-based closes associated with submitted orders before treating them as final broker results. Do not subtract spread a second time: executable bid/ask outcomes already include it. Also fix the basis of the reconstructed gross field, which currently adds price-risk spread R to potentially scaled cash-risk net R.

**The selector also mixes momentum policies.**

The executed evidence loader keys inverted momentum results under the original signal direction. That can be valid for a fixed inversion policy. But it also aggregates older non-inverted trades and original-direction shadow outcomes into the same family/context buckets, without separating execution policy. The paired momentum arm table is explicitly not consumed by this loader. A bucket can therefore mean both “follow the signal” and “reverse the signal.” Resolve this before judging whether the selector is choosing the right momentum opportunities.

A second recording issue exists: 24 linked trade evaluations currently say `no_setup` despite backing a trade. The upsert at `api-server/src/paper-cycle.ts:537` preserves selected execution status and some features while overwriting setup status and quote/geometry fields. This does not prove the trades were invalid at entry; it demonstrates that the mutable evaluation is not a reliable immutable entry snapshot. Preserve a decision-time snapshot for analysis. The reviewed last-week valid non-selected evaluations also have null rejection reasons, though adaptive decision records supply some selection explanations.

**What the larger historical evidence says.**

I recomputed family aggregates directly from the saved 31,449 opportunity rows in `four-family-adaptive-historical-v1/opportunities.jsonl`, matching the existing raw historical report. This covers EUR/USD, GBP/USD, and USD/JPY from 2016–August 3, 2026, with unequal history across pairs. It is a frozen historical opportunity replay, not a new independent test or a broker portfolio simulation.

| Family | Historical opportunities | Gross R/trade | Net R/trade |
|---|---:|---:|---:|
| EMA | 8,577 | -0.032 | -0.168 |
| Breakout | 8,316 | -0.045 | -0.175 |
| Momentum, original | 10,601 | -0.012 | -0.064 |
| Mean reversion | 3,955 | -0.060 | -0.179 |

All four are negative even before the report's cost deduction. Costs worsen an already weak signal; cost reduction alone does not establish an edge. On the 10,591 matched momentum opportunities, original expectancy is -0.0628R and inverted expectancy is -0.0418R. Reversal improves that comparison but remains negative. Ten opportunities missing an inverted twin are excluded only from the paired comparison.

The separate follow/invert/wait V2 experiment selected 296 pre-holdout trades, returned -0.0947R/trade, and waited on 98.8% of opportunities. Its holdout remained sealed after failing development. More selection complexity did not solve the problem and sharply reduced frequency.

**Family-specific improvements worth testing, after measurement repair.**

1. **EMA: test a confirmed pullback sequence.** The existing strategy already has EMA alignment, slope, a pullback zone, extension limits, and a confirmation candle. Adding another trend indicator is not the obvious next step. It recognizes the pullback from the latest candle touching the EMA zone; a new V2 could require a distinct pullback followed by a close through the pullback's directional trigger, then enter on the next executable quote. Compare against frozen V1 on the same opportunities and account for delayed entries, missed trades, and costs. Current pooled results favor trending over mixed regimes, but the mixed subset has only five trades and the R issue contaminates the ranking. Do not install a regime filter from that small slice. EMA remains a reasonable first development baseline, not a proven winner.

2. **Breakout: test an actual break–retest–reclaim sequence.** Current V1 buys/sells a completed close at least 0.5 ATR beyond a 20-bar level, allowing extension up to 3 ATR. The existing `requireRetest` option is not a post-break retest: it checks the same pre-break window used to define the high/low. The candle defining the range extreme necessarily satisfies that touch test for valid OHLC bars, so enabling the flag does not implement the desired confirmation. A V2 needs a frozen level, a later retest, and a subsequent reclaim before entry. This addresses paying for a move after it has already extended. Whether it improves expectancy is a hypothesis. The prior compressed-H1 variant already failed when the pair universe expanded; do not recycle it as a validated fix.

   Last week breakout had 60 valid recorded signals and zero executed trades, all suppressed. Adaptive records include 37 breakout-only negative-evidence decisions, 17 breakout-plus-momentum negative-evidence decisions, and six decisions selecting momentum while suppressing breakout as negative. Retain shadow measurement rather than loosening gates just to manufacture trades. Evaluate a new entry policy on the shadow opportunity stream with realistic overlap controls.

3. **Momentum: repair policy attribution, then compare continuation versus failed-continuation reversal.** V1 requires a 1.5 ATR run over five bars, directional bodies, consecutive bars, and acceleration. Execution currently reverses the signal unconditionally. These describe different economic hypotheses and need separate policy identities. There are 246 resolved matched forward pairs: original averages -0.205R, inverted +0.030R. But the 55 pairs whose inverted arm actually executed average -0.135R on that arm, while 166 shadow/shadow pairs average +0.047R inverted. The pooled positive figure mixes outcome bases, uses overlapping opportunities, and spans only 13 days; it is not a deployable edge. An exploratory day-block bootstrap for the pooled inverted mean spans approximately -0.086 to +0.179R and does not establish profitability.

   The entry test should distinguish a run that continues from one that fails to hold its breakout level, using only subsequently completed candles and a later executable fill. Avoid another blanket reversal or a session filter chosen from the current sample. Session patterns conflict between the executed ledger and all paired opportunities. Also audit the target/time horizon: only five of 80 ledger momentum trades reached target, while 39 ended by forced close. Wider structural stops and a 2R target may require more time than the session permits. That is a hypothesis to replay, not a reason to extend holds automatically.

4. **Mean reversion: keep it small and test a real range rejection.** Sixteen forward trades cannot support threshold optimization. Current reversal confirmation accepts a 45% rejection wick OR any opposite-color candle, even a small one; it does not require a failed range escape and close back inside. Test that explicit rejection sequence in a new version. Keep the non-trending gate and target-to-mean logic. Measure available reward after spread before admitting a trade. Current mean-reversion spread / stop distance averages 0.264 price-risk R, so a pip-only spread ceiling is not sufficient to describe economic quality. A spread/risk threshold must be tested for expectancy AND retained opportunity count; an arbitrary 0.1R cutoff would retain only two of the 16 current trades.

**What not to optimize now.**

Do not add trailing stops, breakeven, or partial exits just because losing trades once showed profit. MFE does not establish that protection could have activated before adverse movement. The saved 170-trade M1 exit study includes 29 legacy trades and is not this 201-trade family cohort. All its tested policies were negative on its chronological final-time-segment holdout: the control was -0.436R/trade and even the best-ranked tight fixed geometry was -0.131R/trade across 53 holdout trades. It is evidence against assuming exit management alone will rescue the system, not a family-specific verdict or a newly reproduced broker test.

Do not search dozens of thresholds, pairs, and sessions and then call the winner validated. Selecting the best historical variation can create a false discovery; see Bailey et al., [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf). Existing inspected periods are development data for any new proposal. The August 31–September 4 breakdown in SUMMARY.json is descriptive and was not a predeclared untouched holdout.

**Recommended order of work.**

First, repair R normalization, broker-close reconciliation, immutable signal snapshots, and momentum policy attribution. Rebuild adaptive evidence under a new evidence version with the same per-opportunity units. Validate capped and uncapped winners and losers against actual broker fills; retain missing data explicitly. Preserve historical records for audit.

Then run one frozen V2 entry hypothesis per family as paired shadow research, keeping existing practice risk limits and V1 definitions. Start with EMA and breakout entry timing; treat momentum as two distinct policies; do not tune mean reversion aggressively with 16 trades. Each proposal needs a fixed definition and rejection rule before future outcomes arrive.

Report net expectancy, paired improvement, day-block uncertainty, drawdown, cost stress, retained coverage, and trades per week. Count independent days, not just repeated signals on the same market move. Require positive expectancy and meaningful practical frequency on future chronological data, with an uncertainty bound that supports the claim. No static trade-count threshold alone guarantees adequate evidence. Reject or simplify failed candidates rather than moving the goalposts.

Reproduction: run the four SQL extracts with `_four-family-review-20260905.ts` from `api-server`, saving ledger.json, EXTRA.json, PAIRS.json, and INTEGRITY.json into this directory, then run `node scripts/_four-family-review-analyze.mjs`. Schema discovery is retained separately. SQL files and the reader are under `api-server/scripts/_four-family-review-*`. SUMMARY.json is descriptive; BASIS_REVIEW.json and PAIR_SUMMARY.json expose the measurement and selection differences. No new market replay or deployment verification was performed in this review.
