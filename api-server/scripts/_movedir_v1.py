"""
move-direction-v1 — Big-Move Detector + Direction Engine. TRAIN/DEV ONLY.

Architecture under test:
    every eligible closed bar -> BIG-MOVE DETECTOR -> (big enough?) -> DIRECTION
The detector never sees a direction label; the direction model never sees a
magnitude label. They are trained separately and combined only at decision time.

Feature construction is imported verbatim from _v3_model.py so nothing about the
existing experiments shifts. MFE/MAE/absMove/midRet/longRet/shortRet are LABELS
and are excluded from every feature vector by prefix.

Prior worth stating before the numbers: v2 established that |move| is predictable
(corr ~ +0.29) while signed return is not, and that direction accuracy FALLS on
the largest realised moves. That oracle test used perfect foresight of realised
magnitude, which is a different subset from PREDICTED magnitude, so the
hypothesis is genuinely open and is tested here on its own terms.
"""
import os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler

exec(open(os.path.join(os.path.dirname(__file__), "_v3_model.py")).read().split("ABL = [")[0])

HORIZONS = [int(x) for x in os.environ.get("HORIZONS", "1,3,6,12,24").split(",")]
MARGINS = [float(x) for x in os.environ.get("MARGINS", "0.05").split(",")]
THRESH = [0.20, 0.30, 0.50, 0.75, 1.00]
MIN_EFF = int(os.environ.get("MIN_EFF", "200"))

MOVE_FEATS = sorted({c for g in ("baseline", "rates", "strength", "struct", "inter") for c in GROUPS[g]})
DIR_FEATS = sorted({c for g in ("baseline", "rates", "strength") for c in GROUPS[g]})
print(f"move-detector features: {len(MOVE_FEATS)}   direction features: {len(DIR_FEATS)}")
assert not any(c.startswith(("mfe", "mae", "absMove", "midRet", "longRet", "shortRet")) for c in MOVE_FEATS + DIR_FEATS), \
    "LEAKAGE: a label leaked into the feature vector"
print("label-in-feature check: PASS")

spread_a = df["spreadAtr"].to_numpy()
SLIPA = 0.02


def ci(v, en):
    n = len(v)
    if n < 2: return (np.nan,) * 3
    m = v.mean(); se = v.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    return m, m - 1.96 * se, m + 1.96 * se


def econ(idx, direction, h, en=None):
    mid = df[f"midRet{h}"].to_numpy()[idx] * direction
    net = np.where(direction > 0, df[f"longRet{h}"].to_numpy()[idx], df[f"shortRet{h}"].to_numpy()[idx])
    if en is None:
        m = np.zeros(len(df), dtype=bool); m[idx] = True; en = eff_n(m, h)
    nm, lo, hi = ci(net, en)
    gp, gl = net[net > 0].sum(), -net[net < 0].sum()
    return dict(n=len(idx), eff=en, acc=(mid > 0).mean(), gross=mid.mean(), net=nm, lo=lo, hi=hi,
                pf=(gp / gl) if gl > 0 else float("inf"),
                mfe=df[f"mfe{h}"].to_numpy()[idx].mean(), mae=df[f"mae{h}"].to_numpy()[idx].mean())


def line(tag, r, w=22):
    return (f"  {tag:<{w}}{r['n']:>7}{r['eff']:>7}{r['acc']*100:>7.1f}%{r['gross']:>+10.4f}"
            f"{r['net']:>+10.4f} [{r['lo']:+.4f},{r['hi']:+.4f}]{r['pf']:>7.2f}")


HDR = f"  {'bucket':<22}{'n':>7}{'eff':>7}{'acc':>8}{'gross':>10}{'net':>10}{'net 95% CI':>21}{'PF':>7}"
P = {}

print("\n" + "=" * 122)
print("STEP 1 — BIG-MOVE DETECTOR trained and evaluated ALONE (no direction label involved)")
print("=" * 122)
for h in HORIZONS:
    tr, dv = blocks(h)
    idx = np.where(dv)[0]
    en_all = eff_n(dv, h)
    absm = df[f"absMove{h}"].to_numpy()
    mfe = df[f"mfe{h}"].to_numpy(); mae = df[f"mae{h}"].to_numpy()
    maxexc = np.maximum(mfe, mae)
    required = spread_a + SLIPA + MARGINS[0]
    y_cost = (maxexc > required).astype(int)          # cost-relative target

    Xm = df[MOVE_FEATS].to_numpy(dtype=np.float64)
    sc = StandardScaler().fit(Xm[tr])
    lin = Ridge(alpha=10.0).fit(sc.transform(Xm[tr]), absm[tr])
    gbr = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(Xm[tr], absm[tr])
    gbc = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                         l2_regularization=1.0, random_state=7).fit(Xm[tr], y_cost[tr])
    logi = LogisticRegression(max_iter=1000, C=0.05).fit(sc.transform(Xm[tr]), y_cost[tr])

    pm_lin, pm = lin.predict(sc.transform(Xm[dv])), gbr.predict(Xm[dv])
    pc, pc_lin = gbc.predict_proba(Xm[dv])[:, 1], logi.predict_proba(sc.transform(Xm[dv]))[:, 1]
    P[h] = dict(pm=pm, pc=pc, idx=idx, dv=dv, tr=tr, en=en_all, absm=absm, maxexc=maxexc,
                required=required, y_cost=y_cost)

    print(f"\n### h={h}  corr(pred |move|, real |move|): ridge={np.corrcoef(pm_lin,absm[dv])[0,1]:+.4f}  "
          f"gbt={np.corrcoef(pm,absm[dv])[0,1]:+.4f}   "
          f"cost-target base rate={y_cost[dv].mean()*100:.1f}%")
    print(f"  {'bucket':<10}{'n':>7}{'pred':>8}{'actual':>8}{'median':>8}" +
          "".join(f"{'>'+str(t):>8}" for t in THRESH))
    order = np.argsort(-pm)
    for frac, nm in ((1.0, "All"), (.5, "Top 50%"), (.25, "Top 25%"), (.10, "Top 10%"),
                     (.05, "Top 5%"), (.02, "Top 2%"), (.01, "Top 1%")):
        k = max(30, int(len(pm) * frac)); keep = order[:k]
        a = absm[idx[keep]]
        print(f"  {nm:<10}{k:>7}{pm[keep].mean():>8.3f}{a.mean():>8.3f}{np.median(a):>8.3f}" +
              "".join(f"{100*(a>t).mean():>7.0f}%" for t in THRESH))

print("\n" + "=" * 122)
print("STEP 2 — MAGNITUDE CALIBRATION (predicted vs realised)")
print("=" * 122)
for h in HORIZONS:
    s = P[h]; pm, idx, absm = s["pm"], s["idx"], s["absm"]
    qs = np.quantile(pm, [0, .2, .4, .6, .8, 1.0])
    print(f"\n  h={h}")
    print(f"  {'predicted band':<18}{'n':>8}{'pred mean':>11}{'actual mean':>13}{'ratio':>8}")
    for lo, hi in zip(qs[:-1], qs[1:]):
        sel = (pm >= lo) & ((pm < hi) if hi < qs[-1] else (pm <= hi))
        if sel.sum() < 100: continue
        a = absm[idx[sel]]
        print(f"  [{lo:>6.3f},{hi:>6.3f}]{int(sel.sum()):>8}{pm[sel].mean():>11.3f}"
              f"{a.mean():>13.3f}{a.mean()/max(pm[sel].mean(),1e-9):>8.2f}")

print("\n" + "=" * 122)
print("STEP 3 — CRITICAL INTERACTION: does DIRECTION accuracy improve when a big move is predicted?")
print("=" * 122)
for h in HORIZONS:
    s = P[h]; tr, dv, idx, pm, en = s["tr"], s["dv"], s["idx"], s["pm"], s["en"]
    yd = (df[f"midRet{h}"].to_numpy() > 0).astype(int)
    Xd = df[DIR_FEATS].to_numpy(dtype=np.float64)
    dc = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(Xd[tr], yd[tr])
    pdir = dc.predict_proba(Xd[dv])[:, 1]
    s["pdir"] = pdir
    d = np.where(pdir >= 0.5, 1.0, -1.0)
    qs = np.quantile(pm, [0, .25, .5, .75, .95, 1.0])
    names = ["Low (p0-25)", "Med (p25-50)", "High (p50-75)", "V.High (p75-95)", "Extreme (p95+)"]
    print(f"\n### h={h}")
    print(HDR)
    print(line("ALL BARS", econ(idx, d, h, en)))
    for (lo, hi), nm in zip(zip(qs[:-1], qs[1:]), names):
        sel = (pm >= lo) & ((pm < hi) if hi < qs[-1] else (pm <= hi))
        if sel.sum() < 200: continue
        print(line(nm, econ(idx[sel], d[sel], h)))

print("\n" + "=" * 122)
print("STEP 4 — COST-RATIO SELECTION: predicted magnitude / actual execution cost")
print("=" * 122)
for h in HORIZONS:
    s = P[h]; pm, idx, pdir = s["pm"], s["idx"], s["pdir"]
    cost = spread_a[idx] + SLIPA
    ratio = pm / np.maximum(cost, 1e-9)
    d = np.where(pdir >= 0.5, 1.0, -1.0)
    print(f"\n### h={h}")
    print(HDR)
    for lo, hi, nm in ((0, 1, "<1x cost"), (1, 1.5, "1-1.5x"), (1.5, 2, "1.5-2x"),
                       (2, 3, "2-3x"), (3, 1e9, ">3x cost")):
        sel = (ratio >= lo) & (ratio < hi)
        if sel.sum() < 200: continue
        print(line(nm, econ(idx[sel], d[sel], h)))

print("\n" + "=" * 122)
print("STEP 5 — MOVE THRESHOLD x DIRECTION CONFIDENCE (the combined decision)")
print("=" * 122)
best = []
for h in HORIZONS:
    s = P[h]; pm, idx, pdir, pc = s["pm"], s["idx"], s["pdir"], s["pc"]
    conf = np.maximum(pdir, 1 - pdir)
    d = np.where(pdir >= 0.5, 1.0, -1.0)
    total = len(idx)
    print(f"\n### h={h}")
    print(f"  {'move thr / conf':<22}{'n':>7}{'eff':>7}{'acc':>8}{'gross':>10}{'net':>10}{'net 95% CI':>21}{'PF':>7}  WAIT")
    for mt in THRESH:
        for ct in (0.50, 0.55, 0.60, 0.65):
            sel = (pm > mt) & (conf >= ct)
            if sel.sum() < 200: continue
            r = econ(idx[sel], d[sel], h)
            print(line(f">{mt:.2f} / {int(ct*100)}%+", r) + f"  {100*(1-sel.mean()):>4.1f}%")
            if r["net"] > 0 and r["eff"] >= MIN_EFF:
                best.append((h, mt, ct, r))

print("\n" + "=" * 122)
print("STEP 6 — LONG vs SHORT for the widest sensible gate")
print("=" * 122)
for h in HORIZONS:
    s = P[h]; pm, idx, pdir = s["pm"], s["idx"], s["pdir"]
    conf = np.maximum(pdir, 1 - pdir)
    sel = (pm > 0.30) & (conf >= 0.55)
    if sel.sum() < 200: continue
    d = np.where(pdir[sel] >= 0.5, 1.0, -1.0)
    print(f"\n### h={h}  gate: predicted move > 0.30 ATR and confidence >= 55%")
    print(HDR)
    print(line("BOTH", econ(idx[sel], d, h)))
    for nm, sgn in (("LONG only", 1.0), ("SHORT only", -1.0)):
        ss = d == sgn
        if ss.sum() < 100: continue
        print(line(nm, econ(idx[sel][ss], np.full(int(ss.sum()), sgn), h)))

print("\n" + "=" * 122)
print("DEV GATE — any combined cell with net > 0 and effective n >= %d?" % MIN_EFF)
print("=" * 122)
if not best:
    print("\n  NONE.")
else:
    print(f"\n  {len(best)} cell(s):")
    for h, mt, ct, r in sorted(best, key=lambda x: -x[3]["net"]):
        print(f"   h={h:<3} move>{mt:.2f} conf>={int(ct*100)}%  eff={r['eff']:>5} "
              f"net={r['net']:+.4f} CI=[{r['lo']:+.4f},{r['hi']:+.4f}]  CI>0: {'YES' if r['lo']>0 else 'no'}")
