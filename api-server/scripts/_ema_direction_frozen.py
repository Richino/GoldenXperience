"""
EMA direction — robustness on DEV, then the single sealed read.

FROZEN CANDIDATE (registered before any sealed data was touched):
    model      logistic regression, C=0.1, StandardScaler fit on TRAIN only
    features   all 60 point-in-time features, no selection
    horizon    1 bar (15m)
    rule       always trade, P(up) >= 0.5 -> LONG else SHORT
    chosen     because it is the ONLY DEV result whose accuracy AND gross
               expectancy both had 95% intervals excluding zero, and because a
               1-bar label has no overlap, so effective n equals raw n and the
               interval needs no widening.

The frozen hypothesis is about EXISTENCE, not profit:
    H1: gross (mid-price) expectancy > 0 on sealed data.
Net expectancy is reported on the same trades — costing the identical
predictions adds no multiple comparison — but no threshold was tuned to it.

Run robustness with no argument; run the sealed read with SEALED=1.
"""
import json, os
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

PATH = os.environ.get("AUDIT", "ema-direction.jsonl")
H = 1
rows = [json.loads(l) for l in open(PATH) if l.strip()]
ts = np.array([np.datetime64(r["ts"][:19]) for r in rows])
pair = np.array([r["pair"] for r in rows])
is_opp = np.array([bool(r["isOpportunity"]) for r in rows])
session = np.array([r["session"] for r in rows])
month = np.array([str(t)[:7] for t in ts])
TRAIN_END, DEV_END = np.datetime64("2024-08-01"), np.datetime64("2025-08-01")

EXCL_P = ("midRet", "longRet", "shortRet", "mfeLong", "maeLong")
EXCL = {"pair", "ts", "isOpportunity", "session", "emaFast", "emaSlow", "atr"}
FEATURES = [k for k in rows[0].keys() if k not in EXCL and not k.startswith(EXCL_P)]
SESSIONS = sorted(set(session.tolist()))
X = np.hstack([np.array([[float(r.get(f, 0) or 0) for f in FEATURES] for r in rows]),
               np.array([[1.0 if s == sv else 0.0 for sv in SESSIONS] for s in session])])
X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
mid = np.array([float(r.get(f"midRet{H}", 0) or 0) for r in rows])
lng = np.array([float(r.get(f"longRet{H}", 0) or 0) for r in rows])
sht = np.array([float(r.get(f"shortRet{H}", 0) or 0) for r in rows])
y = (mid > 0).astype(int)

emb = np.timedelta64(H * 15, "m")
TR = (ts < TRAIN_END - emb) & is_opp
DV = (ts >= TRAIN_END) & (ts < DEV_END - emb) & is_opp
SL = (ts >= DEV_END) & is_opp


def fit(mask):
    sc = StandardScaler().fit(X[mask])
    return sc, LogisticRegression(max_iter=2000, C=0.1).fit(sc.transform(X[mask]), y[mask])


def evaluate(sc, model, mask, spread_mult=1.0, delay=False, drop_top=0):
    p = model.predict_proba(sc.transform(X[mask]))[:, 1]
    d = np.where(p >= 0.5, 1.0, -1.0)
    g = mid[mask] * d
    n = np.where(d > 0, lng[mask], sht[mask])
    if spread_mult != 1.0:                      # widen the toll, keep the price path
        cost = mid[mask] * d - n
        n = mid[mask] * d - cost * spread_mult
    if delay:                                   # act one bar late on the same signal
        g = np.roll(g, -1)[:-1]; n = np.roll(n, -1)[:-1]
    if drop_top:                                # strip the best trades entirely
        keep = np.argsort(-n)[drop_top:]
        g, n = g[keep], n[keep]
    def ci(v):
        m = v.mean(); se = v.std(ddof=1) / np.sqrt(len(v))
        return m, m - 1.96 * se, m + 1.96 * se
    gm, glo, ghi = ci(g); nm, nlo, nhi = ci(n)
    return dict(n=len(g), acc=f"{(g>0).mean()*100:.1f}%",
                gross=f"{gm:+.4f}", gross_ci=f"[{glo:+.4f},{ghi:+.4f}]",
                net=f"{nm:+.4f}", net_ci=f"[{nlo:+.4f},{nhi:+.4f}]",
                gross_pos="yes" if glo > 0 else "no")


def show(title, res):
    print(f"  {title:<34} n={res['n']:>6}  acc={res['acc']:>6}  "
          f"gross={res['gross']} {res['gross_ci']:<20} net={res['net']} {res['net_ci']}")


sc, model = fit(TR)

if os.environ.get("SEALED") != "1":
    print("=" * 100)
    print("ROBUSTNESS — frozen candidate on DEV. No retuning; the model is fit on TRAIN only.")
    print("=" * 100)
    show("baseline DEV", evaluate(sc, model, DV))
    show("+25% spread", evaluate(sc, model, DV, spread_mult=1.25))
    show("+50% spread", evaluate(sc, model, DV, spread_mult=1.50))
    show("1-bar delayed entry", evaluate(sc, model, DV, delay=True))
    show("drop top 5 winners", evaluate(sc, model, DV, drop_top=5))
    show("drop top 10 winners", evaluate(sc, model, DV, drop_top=10))
    print()
    for p in sorted(set(pair.tolist())):
        show(f"drop pair {p}", evaluate(sc, model, DV & (pair != p)))
    print()
    months = sorted(set(month[DV].tolist()))
    perf = {}
    for mth in months:
        m = DV & (month == mth)
        if m.sum() < 200: continue
        pr = model.predict_proba(sc.transform(X[m]))[:, 1]
        perf[mth] = (mid[m] * np.where(pr >= 0.5, 1.0, -1.0)).mean()
    bestm = max(perf, key=perf.get)
    show(f"drop best month ({bestm})", evaluate(sc, model, DV & (month != bestm)))
    half = months[len(months)//2]
    show(f"first half (< {half})", evaluate(sc, model, DV & (month < half)))
    show(f"second half (>= {half})", evaluate(sc, model, DV & (month >= half)))
    print()
    for s in SESSIONS:
        m = DV & (session == s)
        if m.sum() < 300: continue
        show(f"session {s}", evaluate(sc, model, m))
    print()
    print("  FALSIFICATION — is the gross signal concentrated in one place?")
    for p in sorted(set(pair.tolist())):
        show(f"  only {p}", evaluate(sc, model, DV & (pair == p)))
else:
    print("=" * 100)
    print("SEALED HOLDOUT — read once. Model refit on TRAIN+DEV, frozen spec, no retuning.")
    print("=" * 100)
    sc2, model2 = fit(TR | DV)
    show("SEALED overall", evaluate(sc2, model2, SL))
    p = model2.predict_proba(sc2.transform(X[SL]))[:, 1]
    d = np.where(p >= 0.5, 1.0, -1.0)
    idx = np.where(SL)[0]
    for side, sgn in (("LONG", 1.0), ("SHORT", -1.0)):
        sel = d == sgn
        if sel.sum() < 30: continue
        m = np.zeros(len(rows), dtype=bool); m[idx[sel]] = True
        show(f"SEALED {side}", evaluate(sc2, model2, m))
    for pr in sorted(set(pair.tolist())):
        m = SL & (pair == pr)
        if m.sum() < 200: continue
        show(f"SEALED {pr}", evaluate(sc2, model2, m))
