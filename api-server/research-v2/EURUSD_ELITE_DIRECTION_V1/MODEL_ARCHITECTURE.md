# Model architecture

EURUSD_ELITE_DIRECTION_V1 is a mixture of nine separately trained experts: raw_price, structure, momentum, regime, multi_timeframe, location, liquidity, relative_strength, macro_news. Raw-price and multi-timeframe branches use small nonlinear neural experts; the remaining branches use regularized logistic experts. Each branch estimates its own P(TP before SL) for LONG and SHORT.

A 12x4 gating/fusion MLP consumes only expert probabilities plus causal regime, spread, and session context. Fusion training occurs strictly after expert training in time. Eight versus sixteen epochs are selected by development Brier score (early stopping proxy); L2 regularization is applied throughout.

The eleven-stage output maps macro/news, relative strength, regime, HTF structure, location, liquidity, momentum, LTF confirmation, side-by-side LONG/SHORT evidence, cost-aware probabilities, and a final LONG/SHORT/WAIT decision. WAIT is emitted below the development-selected probability threshold or below a 0.02 side margin.

`DECISIONS.csv` records both side probabilities from every expert at every final-period decision timestamp. In `COMPONENT_RESULTS.csv`, directional accuracy means whether the component's higher-scored side had the better realized R of LONG versus SHORT; tied outcomes are excluded. Brier score measures calibration of the selected side's TP-before-SL probability. Context/filter value is judged primarily by chronological ablation, not forced directional accuracy.

This script imports no execution, collector, paper-cycle, or production strategy module.
