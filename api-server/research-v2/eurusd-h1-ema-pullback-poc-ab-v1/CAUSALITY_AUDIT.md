# Causality audit — EURUSD H1 EMA pullback POC A/B v1

Any FAIL invalidates the experiment.

- PASS — EMA uses completed H1 mid closes only; bar t cannot see t+1
- PASS — Previous high/low is h1[t-1]; three-bar stop uses t, t-1, t-2
- PASS — Entry is next H1 open (first executable MBA open after signal completion)
- PASS — No sampled opportunity enters before the signal bar completes
- PASS — Yesterday POC is keyed by previous UTC date; current UTC day is not in that key
- PASS — B never accepts a signal that A rejected for geometry/spread/entry
- PASS — 330 opportunities differ solely by BLOCKED_BY_POC
- PASS — H1 ask is not below bid on the sampled prefix
- PASS — Position size uses the version's current closed-trade balance only
- PASS — 48h exit uses first H1 open at or after entry+48h; no future fill price before that bar

## Classification gate

PASSED — proceed to A/B metrics.
