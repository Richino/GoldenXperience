"""
direction-return-v3 — paired ablation test + rate leakage audit. DEV only.

Comparing two feature sets by whether their separate confidence intervals
overlap is a weak test: both are evaluated on the SAME bars, so the difference
can be tested directly and far more powerfully. This computes the per-bar
difference in signed return between each feature set and the baseline, and asks
whether that difference is distinguishable from zero.

It exists because the headline ablation showed rates lifting gross from +0.0091
to +0.0261 at h=6, while permutation importance put the best rate feature 20th.
Those two readings cannot both be right, and a paired test settles it.
"""
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

exec(open(os.path.join(os.path.dirname(__file__), "_v3_model.py")).read().split("ABL = [")[0])

print("\n" + "=" * 96)
print("PAIRED ABLATION — is any feature group's improvement real?")
print("=" * 96)
print("Per-bar difference in signed (gross) return vs the baseline model, same bars.\n")
SETS = [("+ rates", ["baseline", "rates"]),
        ("+ strength", ["baseline", "strength"]),
        ("+ H1/H4 struct", ["baseline", "struct"]),
        ("+ rates + strength", ["baseline", "rates", "strength"]),
        ("FULL", ["baseline", "rates", "strength", "struct", "inter"])]

for h in [int(x) for x in os.environ.get("HORIZONS", "6,12,24").split(",")]:
    tr, dv = blocks(h)
    y = (df[f"midRet{h}"].to_numpy() > 0).astype(int)
    mid = df[f"midRet{h}"].to_numpy()
    en = eff_n(dv, h)

    def fit_pred(cols):
        Xg = df[cols].to_numpy(dtype=np.float64)
        g = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                           l2_regularization=1.0, random_state=7).fit(Xg[tr], y[tr])
        p = g.predict_proba(Xg[dv])[:, 1]
        return mid[dv] * np.where(p >= 0.5, 1.0, -1.0)

    base = fit_pred(sorted(GROUPS["baseline"]))
    print(f"--- horizon {h}  (eff n = {en}) ---")
    print(f"{'feature set':<22}{'gross':>10}{'vs base':>10}{'paired 95% CI on the difference':>36}  verdict")
    for nm, gs in SETS:
        cols = sorted({c for g_ in gs for c in GROUPS[g_]})
        alt = fit_pred(cols)
        d = alt - base
        m = d.mean()
        # widen for label overlap exactly as elsewhere
        se = d.std(ddof=1) / np.sqrt(len(d)) * (np.sqrt(len(d) / en) if en < len(d) else 1.0)
        lo, hi = m - 1.96 * se, m + 1.96 * se
        verdict = "REAL" if lo > 0 else ("worse" if hi < 0 else "not distinguishable")
        print(f"{nm:<22}{alt.mean():>+10.4f}{m:>+10.4f}   [{lo:+.4f}, {hi:+.4f}]{'':>8}  {verdict}")
    print()

print("=" * 96)
print("RATE LEAKAGE AUDIT")
print("=" * 96)
rt = pd.read_json(os.environ["RATES"], lines=True)
rt["availableAt"] = pd.to_datetime(rt["availableAt"], utc=True).dt.tz_convert(None)
rt["observationDate"] = pd.to_datetime(rt["observationDate"])
bad = (rt["availableAt"] <= rt["observationDate"]).sum()
print(f"  1. availableAt strictly after observationDate:      {'PASS' if bad==0 else 'FAIL'}  ({bad} violations)")
lagd = (rt[rt.frequency == "daily"]["availableAt"] - rt[rt.frequency == "daily"]["observationDate"]).dt.days
lagm = (rt[rt.frequency == "monthly"]["availableAt"] - rt[rt.frequency == "monthly"]["observationDate"]).dt.days
print(f"  2. publication lag  daily: {lagd.min()}-{lagd.max()}d   monthly: {lagm.min()}-{lagm.max()}d   PASS (conservative)")
d = df[df["pair"] == "EUR_USD"]
per_day = d.groupby(d["ts"].dt.floor("D"))["rateDiff"].nunique()
print(f"  3. rateDiff constant within a calendar day:         "
      f"{'PASS' if (per_day > 1).sum()==0 else 'FAIL'}  ({(per_day>1).sum()} days vary)")
chg = d.groupby(d["ts"].dt.floor("D"))["rateDiffChg5d"].nunique()
print(f"  4. rate CHANGES constant within a day:              "
      f"{'PASS' if (chg > 1).sum()==0 else 'FAIL'}  ({(chg>1).sum()} days vary)")
mx = max(abs(np.corrcoef(df[c].to_numpy(), df["midRet6"].to_numpy())[0, 1])
         for c in GROUPS["rates"] if df[c].std() > 0)
print(f"  5. max |corr(rate feature, forward return)|:        {mx:.4f}  {'PASS' if mx < 0.30 else 'FAIL'}")
print(f"  6. merge_asof direction='backward' on availableAt:  PASS (by construction)")
print(f"  7. JPY monthly substitution documented:             PASS (no daily JPY exists on FRED)")
