"""
EMA direction engine — modelling pass.

Answers, in this order and never conflating them:
  1. Do the EMA opportunity moments carry ANY directional information at all?
     Measured on mid-price, before costs.
  2. If so, is it large enough to survive the spread? Measured on executable
     bid/ask returns.
  3. Does model confidence mean anything, and is it calibrated?
  4. Is the EMA detector choosing better moments than matched control bars?

Discipline:
  - Chronological split. TRAIN fits, DEV chooses (horizon, model, threshold),
    SEALED is untouched until a frozen candidate exists and is read exactly once.
  - Purge and embargo around split boundaries: with an h-bar forward label, the
    last h observations of a block overlap the next block and are dropped.
  - Overlapping labels inflate n. Effective independent n is reported alongside
    raw n everywhere it matters, and confidence intervals use the effective
    count, not the raw one.
  - Scaler and calibrator are fit on TRAIN only. Nothing is refit on DEV or
    SEALED.

Run with SEALED=1 only after a candidate is frozen.
"""
import json, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.inspection import permutation_importance

PATH = os.environ.get("AUDIT", "ema-direction.jsonl")
HORIZONS = [1, 3, 6, 12, 24]
USE_SEALED = os.environ.get("SEALED") == "1"
BARS_MS = 15 * 60 * 1000

TRAIN_END = np.datetime64("2024-08-01")
DEV_END = np.datetime64("2025-08-01")

rows = [json.loads(l) for l in open(PATH) if l.strip()]
print(f"loaded {len(rows)} rows")

ts = np.array([np.datetime64(r["ts"][:19]) for r in rows])
pair = np.array([r["pair"] for r in rows])
is_opp = np.array([bool(r["isOpportunity"]) for r in rows])
session = np.array([r["session"] for r in rows])

EXCLUDE_PREFIX = ("midRet", "longRet", "shortRet", "mfeLong", "maeLong")
EXCLUDE = {"pair", "ts", "isOpportunity", "session", "emaFast", "emaSlow", "atr"}
FEATURES = [k for k in rows[0].keys()
            if k not in EXCLUDE and not k.startswith(EXCLUDE_PREFIX)]
# Session is categorical; encode explicitly rather than leaving it out.
SESSIONS = sorted(set(session.tolist()))
print(f"{len(FEATURES)} numeric features + {len(SESSIONS)} session dummies")

X_base = np.array([[float(r.get(f, 0) or 0) for f in FEATURES] for r in rows], dtype=np.float64)
X_sess = np.array([[1.0 if s == sv else 0.0 for sv in SESSIONS] for s in session])
X = np.hstack([X_base, X_sess])
X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
FEATNAMES = FEATURES + [f"session::{s}" for s in SESSIONS]

lab = {h: {k: np.array([float(r.get(f"{k}{h}", 0) or 0) for r in rows])
           for k in ("midRet", "longRet", "shortRet")} for h in HORIZONS}


def blocks(h):
    """Chronological masks with purge+embargo of h bars at each boundary."""
    embargo = np.timedelta64(int(h * 15), "m")
    tr = (ts < TRAIN_END - embargo)
    dv = (ts >= TRAIN_END) & (ts < DEV_END - embargo)
    sl = (ts >= DEV_END)
    return tr, dv, sl


def effective_n(mask, h):
    """Overlapping forward windows make neighbouring rows near-duplicates.
    Thin per pair to one observation every h bars for an independent count."""
    n = 0
    for p in set(pair[mask].tolist()):
        t = np.sort(ts[mask & (pair == p)].astype("datetime64[m]").astype(np.int64))
        if len(t) == 0:
            continue
        last = -10**18
        for v in t:
            if v - last >= h * 15:
                n += 1
                last = v
    return n


def summarise(name, direction, mask, h, eff=None):
    """direction: +1 long, -1 short, 0 wait. Gross uses mid, net uses executable."""
    d = direction[mask]
    taken = d != 0
    n = int(taken.sum())
    if n == 0:
        return dict(method=name, n=0, acc="-", gross="-", net="-", ci="-", pf="-", wait="100%")
    mid = lab[h]["midRet"][mask][taken] * d[taken]
    net = np.where(d[taken] > 0, lab[h]["longRet"][mask][taken], lab[h]["shortRet"][mask][taken])
    acc = float((mid > 0).mean())
    en = eff if eff is not None else max(1, effective_n(mask, h))
    scale = np.sqrt(n / en) if en < n else 1.0     # widen CI for overlap
    se = net.std(ddof=1) / np.sqrt(n) * scale
    gp = net[net > 0].sum()
    gl = -net[net < 0].sum()
    return dict(method=name, n=n, eff_n=en, acc=f"{acc*100:.1f}%",
                gross=f"{mid.mean():+.4f}", net=f"{net.mean():+.4f}",
                ci=f"[{net.mean()-1.96*se:+.4f},{net.mean()+1.96*se:+.4f}]",
                pf=f"{gp/gl:.2f}" if gl > 0 else "inf",
                wait=f"{100*(1-taken.mean()):.0f}%")


def table(rowsout, title):
    print(f"\n--- {title} ---")
    if not rowsout:
        print("(empty)")
        return
    keys = list(rowsout[0].keys())
    w = {k: max(len(k), max(len(str(r.get(k, ""))) for r in rowsout)) for k in keys}
    print("  ".join(k.ljust(w[k]) for k in keys))
    for r in rowsout:
        print("  ".join(str(r.get(k, "")).ljust(w[k]) for k in keys))


sep_idx = FEATNAMES.index("emaSeparationAtr")
h1_idx = FEATNAMES.index("h1Aligned")

print("\n" + "=" * 72)
print("BASELINES on EMA opportunity timestamps (DEV)")
print("=" * 72)
for h in HORIZONS:
    tr, dv, sl = blocks(h)
    m = dv & is_opp
    eff = max(1, effective_n(m, h))
    ema_dir = np.sign(X[:, sep_idx])
    ema_dir[ema_dir == 0] = 1
    rng = np.random.default_rng(20260821)
    rand_nets = []
    for _ in range(20):
        rd = rng.choice([-1.0, 1.0], size=len(rows))
        t = rd[m] != 0
        rand_nets.append(np.where(rd[m][t] > 0, lab[h]["longRet"][m][t], lab[h]["shortRet"][m][t]).mean())
    h1_dir = np.sign(X[:, h1_idx]); h1_dir[h1_dir == 0] = 1
    out = [summarise("A original EMA", ema_dir, m, h, eff),
           summarise("B reversed EMA", -ema_dir, m, h, eff),
           summarise("D higher-TF H1", h1_dir, m, h, eff)]
    out.append(dict(method="C random (20 seeds)", n=int(m.sum()), eff_n=eff, acc="50.0%",
                    gross="-", net=f"{np.mean(rand_nets):+.4f}",
                    ci=f"[{np.percentile(rand_nets,2.5):+.4f},{np.percentile(rand_nets,97.5):+.4f}]",
                    pf="-", wait="0%"))
    table(out, f"horizon {h} bars ({h*15}m)")

print("\n" + "=" * 72)
print("MODEL — trained on TRAIN, evaluated on DEV")
print("=" * 72)
results = {}
for h in HORIZONS:
    tr, dv, sl = blocks(h)
    trm, dvm = tr & is_opp, dv & is_opp
    y = (lab[h]["midRet"] > 0).astype(int)
    scaler = StandardScaler().fit(X[trm])
    Xtr, Xdv = scaler.transform(X[trm]), scaler.transform(X[dvm])
    eff = max(1, effective_n(dvm, h))

    lr = LogisticRegression(max_iter=2000, C=0.1).fit(Xtr, y[trm])
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_depth=4,
                                        l2_regularization=1.0, random_state=7).fit(X[trm], y[trm])
    out = []
    for name, p in (("logistic", lr.predict_proba(Xdv)[:, 1]), ("gbt", gb.predict_proba(X[dvm])[:, 1])):
        d = np.zeros(len(rows))
        idx = np.where(dvm)[0]
        d[idx] = np.where(p >= 0.5, 1.0, -1.0)
        r = summarise(name, d, dvm, h, eff)
        r["brier"] = f"{brier_score_loss(y[dvm], p):.4f}"
        r["logloss"] = f"{log_loss(y[dvm], np.clip(p,1e-6,1-1e-6)):.4f}"
        out.append(r)
        results[(h, name)] = (p, idx, y[dvm])
    table(out, f"horizon {h} bars — always-trade (threshold 0.5)")

print("\n" + "=" * 72)
print("CONFIDENCE AUDIT — gbt, DEV, per horizon")
print("=" * 72)
for h in HORIZONS:
    p, idx, ytrue = results[(h, "gbt")]
    conf = np.maximum(p, 1 - p)
    edges = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 1.01]
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (conf >= lo) & (conf < hi)
        if sel.sum() < 20:
            continue
        d = np.where(p[sel] >= 0.5, 1.0, -1.0)
        mid = lab[h]["midRet"][idx[sel]] * d
        net = np.where(d > 0, lab[h]["longRet"][idx[sel]], lab[h]["shortRet"][idx[sel]])
        acc = float((mid > 0).mean())
        se = net.std(ddof=1) / np.sqrt(len(net))
        out.append(dict(bucket=f"{lo:.2f}-{hi:.2f}", n=int(sel.sum()), acc=f"{acc*100:.1f}%",
                        gross=f"{mid.mean():+.4f}", net=f"{net.mean():+.4f}",
                        ci=f"[{net.mean()-1.96*se:+.4f},{net.mean()+1.96*se:+.4f}]"))
    table(out, f"horizon {h} bars")

print("\n" + "=" * 72)
print("EMA TIMING VALUE — same model, opportunity bars vs matched control bars")
print("=" * 72)
for h in [6, 24]:
    tr, dv, sl = blocks(h)
    y = (lab[h]["midRet"] > 0).astype(int)
    trm = tr & is_opp
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_depth=4,
                                        l2_regularization=1.0, random_state=7).fit(X[trm], y[trm])
    out = []
    for label, m in (("EMA opportunities", dv & is_opp), ("matched controls", dv & ~is_opp)):
        if m.sum() < 50:
            continue
        p = gb.predict_proba(X[m])[:, 1]
        d = np.zeros(len(rows)); d[np.where(m)[0]] = np.where(p >= 0.5, 1.0, -1.0)
        r = summarise(label, d, m, h)
        out.append(r)
    table(out, f"horizon {h} bars")

print("\n" + "=" * 72)
print("FEATURE IMPORTANCE — gbt, permutation on DEV, horizon 6")
print("=" * 72)
h = 6
tr, dv, sl = blocks(h)
trm, dvm = tr & is_opp, dv & is_opp
y = (lab[h]["midRet"] > 0).astype(int)
gb = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=4,
                                    l2_regularization=1.0, random_state=7).fit(X[trm], y[trm])
sub = np.where(dvm)[0][:8000]
imp = permutation_importance(gb, X[sub], y[sub], n_repeats=5, random_state=7, scoring="neg_log_loss")
order = np.argsort(-imp.importances_mean)[:15]
table([dict(feature=FEATNAMES[i], importance=f"{imp.importances_mean[i]:+.5f}",
            std=f"{imp.importances_std[i]:.5f}") for i in order], "top 15 by permutation importance")

if USE_SEALED:
    print("\n" + "=" * 72)
    print("SEALED HOLDOUT — read once, frozen model")
    print("=" * 72)
    h = int(os.environ.get("FROZEN_H", "6"))
    thr = float(os.environ.get("FROZEN_THR", "0.5"))
    tr, dv, sl = blocks(h)
    fit = (tr | dv) & is_opp
    y = (lab[h]["midRet"] > 0).astype(int)
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_depth=4,
                                        l2_regularization=1.0, random_state=7).fit(X[fit], y[fit])
    m = sl & is_opp
    p = gb.predict_proba(X[m])[:, 1]
    d = np.zeros(len(rows))
    idx = np.where(m)[0]
    d[idx] = np.where(p >= thr, 1.0, np.where(p <= 1 - thr, -1.0, 0.0))
    table([summarise(f"frozen gbt h={h} thr={thr}", d, m, h)], "sealed")
    for nm, sel in (("LONG", d[idx] > 0), ("SHORT", d[idx] < 0)):
        if sel.sum() < 10:
            continue
        dd = np.zeros(len(rows)); dd[idx[sel]] = d[idx[sel]]
        mm = np.zeros(len(rows), dtype=bool); mm[idx[sel]] = True
        table([summarise(nm, dd, mm, h)], f"sealed {nm}")
print("\ndone")
