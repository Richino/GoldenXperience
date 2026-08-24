"""
direction-return-v3 — formal DEV evaluation. TRAIN/DEV ONLY. SEALED NOT READ.

No architecture changes. Feature construction is imported verbatim from
_v3_model.py so the six feature sets, the splits, the purge/embargo and the
effective-n methodology are byte-identical to the ones already established.

Reports, for every feature set x horizon:
  accuracy, gross, net after real spread, 95% CI on net (widened for label
  overlap), effective n, LONG, SHORT, WAIT.

Then ranks by predictedNetEdge = |predicted return| - spread - slippage - margin
and reports All / Top 50 / 25 / 10 / 5 / 2 / 1 %.

Primary question: does any adequately sized DEV subset have net > 0, preferably
with the whole 95% CI above zero.
"""
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

# identical data + feature construction, up to (not including) the ablation list
exec(open(os.path.join(os.path.dirname(__file__), "_v3_model.py")).read().split("ABL = [")[0])

SETS = [("1 baseline 74", ["baseline"]),
        ("2 + rates", ["baseline", "rates"]),
        ("3 + strength", ["baseline", "strength"]),
        ("4 + H1/H4 struct", ["baseline", "struct"]),
        ("5 + rates + strength", ["baseline", "rates", "strength"]),
        ("6 FULL 139", ["baseline", "rates", "strength", "struct", "inter"])]
HORIZONS = [int(x) for x in os.environ.get("HORIZONS", "6,12,24").split(",")]
QUAL_MIN_EFF = int(os.environ.get("QUAL_MIN_EFF", "200"))


def metrics(mask_idx, direction, h, en=None):
    """mask_idx: positional indices of taken bars. direction: +1/-1 aligned to it."""
    if len(mask_idx) < 2:
        return None
    mid = df[f"midRet{h}"].to_numpy()[mask_idx] * direction
    net = np.where(direction > 0, df[f"longRet{h}"].to_numpy()[mask_idx],
                   df[f"shortRet{h}"].to_numpy()[mask_idx])
    if en is None:
        m = np.zeros(len(df), dtype=bool); m[mask_idx] = True
        en = eff_n(m, h)
    n = len(net); mu = net.mean()
    se = net.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    gp, gl = net[net > 0].sum(), -net[net < 0].sum()
    return dict(n=n, eff=en, acc=(mid > 0).mean(), gross=mid.mean(), net=mu,
                lo=mu - 1.96 * se, hi=mu + 1.96 * se,
                pf=(gp / gl) if gl > 0 else float("inf"))


def fmt(r):
    return (f"{r['n']:>6} {r['eff']:>6} {r['acc']*100:>6.1f}% {r['gross']:>+9.4f} "
            f"{r['net']:>+9.4f} [{r['lo']:+.4f},{r['hi']:+.4f}] {r['pf']:>6.2f}")


qualifying = []
cache = {}

print("=" * 118)
print("SECTION A — every feature set x horizon, always-trade (threshold 0.5)")
print("=" * 118)
for h in HORIZONS:
    tr, dv = blocks(h)
    y = (df[f"midRet{h}"].to_numpy() > 0).astype(int)
    yr = df[f"midRet{h}"].to_numpy()
    en_all = eff_n(dv, h)
    idx = np.where(dv)[0]
    print(f"\n### HORIZON {h} bars ({h*15}m)   DEV raw n={int(dv.sum())}  effective n={en_all}")
    print(f"{'feature set':<22}{'side':<7}{'n':>7}{'eff':>7}{'acc':>8}{'gross':>10}{'net':>10}"
          f"{'net 95% CI':>21}{'PF':>7}  WAIT")
    for nm, gs in SETS:
        cols = sorted({c for g_ in gs for c in GROUPS[g_]})
        Xg = df[cols].to_numpy(dtype=np.float64)
        clf = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                             l2_regularization=1.0, random_state=7).fit(Xg[tr], y[tr])
        reg = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                            l2_regularization=1.0, random_state=7).fit(Xg[tr], yr[tr])
        p = clf.predict_proba(Xg[dv])[:, 1]
        pr = reg.predict(Xg[dv])
        cache[(nm, h)] = (p, pr, idx, en_all)
        d = np.where(p >= 0.5, 1.0, -1.0)
        r = metrics(idx, d, h, en_all)
        print(f"{nm:<22}{'ALL':<7}{fmt(r)}   0%")
        for side, sgn in (("LONG", 1.0), ("SHORT", -1.0)):
            sel = d == sgn
            if sel.sum() < 50: continue
            rs = metrics(idx[sel], np.full(int(sel.sum()), sgn), h)
            print(f"{'':<22}{side:<7}{fmt(rs)}  {100*(1-sel.mean()):>3.0f}%")
        if r["net"] > 0 and r["eff"] >= QUAL_MIN_EFF:
            qualifying.append((nm, h, "always-trade", r))

print("\n" + "=" * 118)
print("SECTION B — ranked by predictedNetEdge = |predicted return| - spread - slippage - margin")
print(f"            slippage={SLIP}  margin={MARGIN}   direction = sign(predicted return)")
print("=" * 118)
FRACS = ((1.00, "All"), (0.50, "Top 50%"), (0.25, "Top 25%"), (0.10, "Top 10%"),
         (0.05, "Top 5%"), (0.02, "Top 2%"), (0.01, "Top 1%"))
for h in HORIZONS:
    print(f"\n### HORIZON {h} bars")
    for nm, gs in SETS:
        p, pr, idx, en_all = cache[(nm, h)]
        edge = np.abs(pr) - spread[idx] - SLIP - MARGIN
        order = np.argsort(-edge)
        print(f"\n  -- {nm} --")
        print(f"  {'bucket':<9}{'n':>7}{'eff':>7}{'acc':>8}{'gross':>10}{'net':>10}{'net 95% CI':>21}{'PF':>7}")
        for frac, bn in FRACS:
            k = max(30, int(len(edge) * frac))
            keep = order[:k]
            d = np.sign(pr[keep]); d[d == 0] = 1
            r = metrics(idx[keep], d, h)
            if r is None: continue
            print(f"  {bn:<9}{fmt(r)}")
            if r["net"] > 0 and r["eff"] >= QUAL_MIN_EFF:
                qualifying.append((nm, h, bn, r))

print("\n" + "=" * 118)
print("PRIMARY QUESTION — any adequately-sized DEV subset with net > 0?")
print(f"                   adequacy floor: effective n >= {QUAL_MIN_EFF}")
print("=" * 118)
if not qualifying:
    print("\n  NO subset with net > 0 at or above the adequacy floor.")
else:
    print(f"\n  {len(qualifying)} subset(s) with a POSITIVE net point estimate:\n")
    print(f"  {'set':<22}{'h':>3} {'bucket':<9}{'eff':>6}{'net':>10}{'  95% CI':<22}CI>0?")
    for nm, h, bn, r in sorted(qualifying, key=lambda x: -x[3]["net"]):
        print(f"  {nm:<22}{h:>3} {bn:<9}{r['eff']:>6}{r['net']:>+10.4f}  "
              f"[{r['lo']:+.4f},{r['hi']:+.4f}]     {'YES' if r['lo'] > 0 else 'no'}")
    strict = [q for q in qualifying if q[3]["lo"] > 0]
    print(f"\n  With the ENTIRE 95% CI above zero: {len(strict)}")
