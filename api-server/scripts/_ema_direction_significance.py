"""
EMA direction — significance and threshold selection. DEV ONLY.

Separates the two questions that must never be conflated:
  gross (mid-price)  — does directional information exist?
  net (executable)   — is it big enough to beat the spread?

Confidence intervals use the EFFECTIVE independent sample size, not the raw row
count. Overlapping forward windows make neighbouring rows near-duplicates; using
raw n would shrink every interval by roughly sqrt(h) and manufacture
significance out of the label construction alone.
"""
import json, os
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler

PATH = os.environ.get("AUDIT", "ema-direction.jsonl")
rows = [json.loads(l) for l in open(PATH) if l.strip()]
ts = np.array([np.datetime64(r["ts"][:19]) for r in rows])
pair = np.array([r["pair"] for r in rows])
is_opp = np.array([bool(r["isOpportunity"]) for r in rows])
session = np.array([r["session"] for r in rows])
TRAIN_END, DEV_END = np.datetime64("2024-08-01"), np.datetime64("2025-08-01")

EXCL_P = ("midRet", "longRet", "shortRet", "mfeLong", "maeLong")
EXCL = {"pair", "ts", "isOpportunity", "session", "emaFast", "emaSlow", "atr"}
FEATURES = [k for k in rows[0].keys() if k not in EXCL and not k.startswith(EXCL_P)]
SESSIONS = sorted(set(session.tolist()))
X = np.hstack([np.array([[float(r.get(f, 0) or 0) for f in FEATURES] for r in rows]),
               np.array([[1.0 if s == sv else 0.0 for sv in SESSIONS] for s in session])])
X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
lab = {h: {k: np.array([float(r.get(f"{k}{h}", 0) or 0) for r in rows])
           for k in ("midRet", "longRet", "shortRet")} for h in [1, 3, 6, 12, 24]}


def eff_n(mask, h):
    n = 0
    for p in set(pair[mask].tolist()):
        t = np.sort(ts[mask & (pair == p)].astype("datetime64[m]").astype(np.int64))
        last = -10**18
        for v in t:
            if v - last >= h * 15:
                n += 1
                last = v
    return max(1, n)


def ci(vals, en):
    """95% CI on the mean, widened for label overlap."""
    n = len(vals)
    if n < 2:
        return 0.0, 0.0, 0.0
    m = vals.mean()
    se = vals.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    return m, m - 1.96 * se, m + 1.96 * se


def acc_ci(hits, en):
    p = hits.mean()
    se = np.sqrt(max(p * (1 - p), 1e-9) / en)
    return p, p - 1.96 * se, p + 1.96 * se


def blocks(h):
    emb = np.timedelta64(int(h * 15), "m")
    return ts < TRAIN_END - emb, (ts >= TRAIN_END) & (ts < DEV_END - emb), ts >= DEV_END


print("=" * 78)
print("IS THERE A DIRECTIONAL SIGNAL AT ALL?  (DEV, effective-n intervals)")
print("=" * 78)
print(f"{'h':>3} {'model':<9} {'raw n':>6} {'eff n':>6} {'accuracy':>20} {'gross (mid ATR)':>26} {'signal?':>9}")
best = None
for h in [1, 3, 6, 12, 24]:
    tr, dv, _ = blocks(h)
    trm, dvm = tr & is_opp, dv & is_opp
    y = (lab[h]["midRet"] > 0).astype(int)
    sc = StandardScaler().fit(X[trm])
    en = eff_n(dvm, h)
    for name, p in (
        ("logistic", LogisticRegression(max_iter=2000, C=0.1).fit(sc.transform(X[trm]), y[trm]).predict_proba(sc.transform(X[dvm]))[:, 1]),
        ("gbt", HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_depth=4,
                                               l2_regularization=1.0, random_state=7).fit(X[trm], y[trm]).predict_proba(X[dvm])[:, 1]),
    ):
        d = np.where(p >= 0.5, 1.0, -1.0)
        mid = lab[h]["midRet"][dvm] * d
        a, alo, ahi = acc_ci((mid > 0).astype(float), en)
        g, glo, ghi = ci(mid, en)
        sig = "YES" if (alo > 0.5 and glo > 0) else ("acc only" if alo > 0.5 else "no")
        print(f"{h:>3} {name:<9} {int(dvm.sum()):>6} {en:>6} "
              f"{a*100:5.1f}% [{alo*100:4.1f},{ahi*100:4.1f}] "
              f"{g:+.4f} [{glo:+.4f},{ghi:+.4f}] {sig:>9}")
        if best is None or g > best[0]:
            best = (g, h, name, p, dvm, en)

print("\n" + "=" * 78)
print("COST WALL — how big must gross be to survive the spread?")
print("=" * 78)
for h in [6, 12, 24]:
    tr, dv, _ = blocks(h)
    dvm = dv & is_opp
    cost = (lab[h]["midRet"][dvm] - lab[h]["longRet"][dvm]).mean()
    print(f"  h={h:<3} mean spread cost = {cost:.4f} ATR per trade")

print("\n" + "=" * 78)
print("THRESHOLD SWEEP — LONG / SHORT / WAIT, chosen on DEV only")
print("=" * 78)
print(f"{'h':>3} {'thr':>5} {'trades':>7} {'eff n':>6} {'wait':>6} {'acc':>7} {'gross':>9} "
      f"{'net':>9} {'net 95% CI':>22}")
for h in [6, 12, 24]:
    tr, dv, _ = blocks(h)
    trm, dvm = tr & is_opp, dv & is_opp
    y = (lab[h]["midRet"] > 0).astype(int)
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_depth=4,
                                        l2_regularization=1.0, random_state=7).fit(X[trm], y[trm])
    p = gb.predict_proba(X[dvm])[:, 1]
    idx = np.where(dvm)[0]
    for thr in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        take = (p >= thr) | (p <= 1 - thr)
        if take.sum() < 30:
            continue
        d = np.where(p[take] >= 0.5, 1.0, -1.0)
        sub = np.zeros(len(rows), dtype=bool); sub[idx[take]] = True
        en = eff_n(sub, h)
        mid = lab[h]["midRet"][idx[take]] * d
        net = np.where(d > 0, lab[h]["longRet"][idx[take]], lab[h]["shortRet"][idx[take]])
        a, alo, _ = acc_ci((mid > 0).astype(float), en)
        g, _, _ = ci(mid, en)
        nm, nlo, nhi = ci(net, en)
        print(f"{h:>3} {thr:>5.2f} {int(take.sum()):>7} {en:>6} {100*(1-take.mean()):>5.0f}% "
              f"{a*100:6.1f}% {g:>+9.4f} {nm:>+9.4f} [{nlo:+.4f},{nhi:+.4f}]")

print("\n" + "=" * 78)
print("LONG vs SHORT, separately (DEV, gbt, threshold 0.5) — symmetry is not assumed")
print("=" * 78)
for h in [6, 12, 24]:
    tr, dv, _ = blocks(h)
    trm, dvm = tr & is_opp, dv & is_opp
    y = (lab[h]["midRet"] > 0).astype(int)
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_depth=4,
                                        l2_regularization=1.0, random_state=7).fit(X[trm], y[trm])
    p = gb.predict_proba(X[dvm])[:, 1]
    idx = np.where(dvm)[0]
    for side, sel in (("LONG", p >= 0.5), ("SHORT", p < 0.5)):
        if sel.sum() < 30:
            continue
        sub = np.zeros(len(rows), dtype=bool); sub[idx[sel]] = True
        en = eff_n(sub, h)
        sgn = 1.0 if side == "LONG" else -1.0
        mid = lab[h]["midRet"][idx[sel]] * sgn
        net = lab[h]["longRet"][idx[sel]] if side == "LONG" else lab[h]["shortRet"][idx[sel]]
        a, alo, ahi = acc_ci((mid > 0).astype(float), en)
        g, glo, ghi = ci(mid, en)
        nm, nlo, nhi = ci(net, en)
        print(f"h={h:<3} {side:<6} n={int(sel.sum()):>6} eff={en:>5} "
              f"acc={a*100:5.1f}% [{alo*100:4.1f},{ahi*100:4.1f}]  "
              f"gross={g:+.4f} [{glo:+.4f},{ghi:+.4f}]  net={nm:+.4f} [{nlo:+.4f},{nhi:+.4f}]")
