"""
direction-return-v2 — modelling pass. TRAIN/DEV only. RESEARCH ONLY.

Asks, in order and never conflated:
  A. direction   — can we beat 50% on the sign of the forward move?
  B. magnitude   — can we predict HOW FAR price moves?
  C. cost gate   — does B let us keep only bars whose expected move clears its
                   own execution cost?

The previous phase established that a real but tiny gross signal exists
(+0.0104 ATR sealed) against a ~0.22 ATR spread. Direction alone cannot close a
22x gap. The only way through is if magnitude is predictable enough to isolate a
subset where the move is genuinely larger than the toll. That is the hypothesis
under test, and it is allowed to fail.

Discipline: chronological splits, purge/embargo at boundaries, effective
independent n for every interval, scaler and models fit on TRAIN only.
"""
import os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss

PATH = os.environ.get("DATA", "dirmove.csv")
HORIZONS = [1, 3, 6, 12, 24]
SLIPPAGE = float(os.environ.get("SLIPPAGE", "0.02"))
MARGIN = float(os.environ.get("MARGIN", "0.05"))

df = pd.read_csv(PATH)
df["ts"] = pd.to_datetime(df["ts"], format="mixed", utc=True).dt.tz_convert(None)
df = df.sort_values("ts").reset_index(drop=True)
print(f"rows={len(df)}  pairs={sorted(df['pair'].unique())}")
print(f"range {df['ts'].min()} .. {df['ts'].max()}")

TRAIN_END = pd.Timestamp("2024-08-01")
DEV_END = pd.Timestamp("2025-08-01")

LABEL_P = ("midRet", "absMove", "longRet", "shortRet", "mfe", "mae")
META = {"pair", "ts"}
FEATS = [c for c in df.columns if c not in META and not c.startswith(LABEL_P)]
GROUPS = {
    "m15": [f for f in FEATS if f.startswith("m15") or f in ("spreadPips", "atrPips", "spreadAtr")],
    "h1": [f for f in FEATS if f.startswith("h1")],
    "h4": [f for f in FEATS if f.startswith("h4")],
    "xs": [f for f in FEATS if f.startswith("xs")],
    "time": [f for f in FEATS if f.startswith("sess") or f in ("hour", "dow")],
}
print(f"features={len(FEATS)}  " + "  ".join(f"{k}={len(v)}" for k, v in GROUPS.items()))

X_all = df[FEATS].to_numpy(dtype=np.float64)
X_all = np.nan_to_num(X_all, nan=0.0, posinf=0.0, neginf=0.0)
ts = df["ts"].to_numpy()
pair = df["pair"].to_numpy()
spread_atr = df["spreadAtr"].to_numpy()


def blocks(h):
    emb = pd.Timedelta(minutes=15 * h)
    tr = ts < np.datetime64(TRAIN_END - emb)
    dv = (ts >= np.datetime64(TRAIN_END)) & (ts < np.datetime64(DEV_END - emb))
    sl = ts >= np.datetime64(DEV_END)
    return tr, dv, sl


def eff_n(mask, h):
    """Overlapping labels: thin per pair to one observation every h bars."""
    total = 0
    for p in np.unique(pair[mask]):
        t = np.sort(ts[mask & (pair == p)]).astype("datetime64[m]").astype(np.int64)
        if len(t) == 0:
            continue
        last = -10**18
        for v in t:
            if v - last >= h * 15:
                total += 1
                last = v
    return max(1, total)


def stat(net, mid_signed, en):
    n = len(net)
    if n < 2:
        return dict(n=n, acc="-", gross="-", net="-", ci="-", pf="-")
    m = net.mean()
    se = net.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    gp, gl = net[net > 0].sum(), -net[net < 0].sum()
    return dict(n=n, eff=en, acc=f"{(mid_signed>0).mean()*100:.1f}%",
                gross=f"{mid_signed.mean():+.4f}", net=f"{m:+.4f}",
                ci=f"[{m-1.96*se:+.4f},{m+1.96*se:+.4f}]",
                pf=f"{gp/gl:.2f}" if gl > 0 else "inf")


def table(rows, title):
    print(f"\n--- {title} ---")
    if not rows:
        print("(none)")
        return
    keys = list(rows[0].keys())
    w = {k: max(len(str(k)), max(len(str(r.get(k, ""))) for r in rows)) for k in keys}
    print("  ".join(str(k).ljust(w[k]) for k in keys))
    for r in rows:
        print("  ".join(str(r.get(k, "")).ljust(w[k]) for k in keys))


def take(direction, mask, h):
    """Realised gross/net for a direction vector (+1/-1/0) over a mask."""
    d = direction[mask]
    sel = d != 0
    if sel.sum() == 0:
        return None
    mid = df["midRet%d" % h].to_numpy()[mask][sel] * d[sel]
    net = np.where(d[sel] > 0, df["longRet%d" % h].to_numpy()[mask][sel],
                   df["shortRet%d" % h].to_numpy()[mask][sel])
    sub = np.zeros(len(df), dtype=bool)
    sub[np.where(mask)[0][sel]] = True
    return mid, net, eff_n(sub, h)


print("\n" + "=" * 92)
print("STEP 1 — BASELINES on ALL eligible bars (DEV)")
print("=" * 92)
for h in [1, 6, 24]:
    tr, dv, sl = blocks(h)
    rows = []
    ema_dir = np.sign(df["m15EmaSepAtr"].to_numpy()); ema_dir[ema_dir == 0] = 1
    h1_dir = np.sign(df["h1EmaSepAtr"].to_numpy()); h1_dir[h1_dir == 0] = 1
    rng = np.random.default_rng(20260821)
    rand = rng.choice([-1.0, 1.0], size=len(df))
    for nm, d in (("old EMA (M15 stack)", ema_dir), ("reversed EMA", -ema_dir),
                  ("H1 trend", h1_dir), ("random", rand)):
        r = take(d, dv, h)
        if r:
            rows.append(dict(method=nm, **stat(r[1], r[0], r[2])))
    table(rows, f"horizon {h} bars")

print("\n" + "=" * 92)
print("STEP 2 — MODEL A (direction) and MODEL B (magnitude), TRAIN -> DEV")
print("=" * 92)
store = {}
for h in HORIZONS:
    tr, dv, sl = blocks(h)
    y_dir = (df["midRet%d" % h].to_numpy() > 0).astype(int)
    y_ret = df["midRet%d" % h].to_numpy()
    sc = StandardScaler().fit(X_all[tr])
    Xtr_s, Xdv_s = sc.transform(X_all[tr]), sc.transform(X_all[dv])

    clf_l = LogisticRegression(max_iter=1000, C=0.05).fit(Xtr_s, y_dir[tr])
    clf_g = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                           l2_regularization=1.0, random_state=7).fit(X_all[tr], y_dir[tr])
    reg_l = Ridge(alpha=10.0).fit(Xtr_s, y_ret[tr])
    reg_g = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                          l2_regularization=1.0, random_state=7).fit(X_all[tr], y_ret[tr])

    p_l, p_g = clf_l.predict_proba(Xdv_s)[:, 1], clf_g.predict_proba(X_all[dv])[:, 1]
    r_l, r_g = reg_l.predict(Xdv_s), reg_g.predict(X_all[dv])
    en = eff_n(dv, h)
    rows = []
    for nm, p in (("A logistic", p_l), ("A gbt", p_g)):
        d = np.zeros(len(df)); d[np.where(dv)[0]] = np.where(p >= 0.5, 1.0, -1.0)
        m, n_, e = take(d, dv, h)
        rows.append(dict(model=nm, **stat(n_, m, e),
                         brier=f"{brier_score_loss(y_dir[dv], p):.4f}",
                         logloss=f"{log_loss(y_dir[dv], np.clip(p,1e-6,1-1e-6)):.4f}"))
    for nm, r in (("B ridge", r_l), ("B gbt", r_g)):
        d = np.zeros(len(df)); d[np.where(dv)[0]] = np.sign(r); d[d == 0] = 1
        m, n_, e = take(d, dv, h)
        corr = np.corrcoef(r, y_ret[dv])[0, 1]
        rows.append(dict(model=nm, **stat(n_, m, e), brier="-", logloss=f"corr={corr:+.4f}"))
    table(rows, f"horizon {h} bars ({h*15}m)  eff_n={en}")
    store[h] = dict(p_g=p_g, p_l=p_l, r_g=r_g, r_l=r_l, dv=dv, tr=tr, en=en)

print("\n" + "=" * 92)
print("STEP 3 — MAGNITUDE CALIBRATION: predicted vs realised move (DEV, gbt regressor)")
print("=" * 92)
for h in [6, 24]:
    s = store[h]; dv = s["dv"]
    pred = s["r_g"]; real = df["midRet%d" % h].to_numpy()[dv]
    qs = np.quantile(np.abs(pred), [0, .5, .75, .9, .95, .99, 1.0])
    rows = []
    for lo, hi, nm in zip(qs[:-1], qs[1:], ["p0-50", "p50-75", "p75-90", "p90-95", "p95-99", "p99-100"]):
        sel = (np.abs(pred) >= lo) & (np.abs(pred) < hi if hi < qs[-1] else np.abs(pred) <= hi)
        if sel.sum() < 50:
            continue
        rows.append(dict(bucket=nm, n=int(sel.sum()),
                         pred_abs=f"{np.abs(pred[sel]).mean():.4f}",
                         real_abs=f"{np.abs(real[sel]).mean():.4f}",
                         ratio=f"{np.abs(real[sel]).mean()/max(np.abs(pred[sel]).mean(),1e-9):.2f}",
                         mean_spread=f"{spread_atr[dv][sel].mean():.4f}"))
    table(rows, f"horizon {h} — is predicted magnitude calibrated?")

print("\n" + "=" * 92)
print("STEP 4 — COST WALL: keep only the largest predicted moves")
print("=" * 92)
for h in [6, 12, 24]:
    s = store[h]; dv = s["dv"]; pred = s["r_g"]; p = s["p_g"]
    idx = np.where(dv)[0]
    rows = []
    for frac, nm in ((1.0, "all"), (0.5, "top 50%"), (0.25, "top 25%"),
                     (0.10, "top 10%"), (0.05, "top 5%"), (0.01, "top 1%")):
        k = max(30, int(len(pred) * frac))
        keep = np.argsort(-np.abs(pred))[:k]
        d = np.zeros(len(df)); d[idx[keep]] = np.sign(pred[keep]); d[d == 0] = 1
        m = np.zeros(len(df), dtype=bool); m[idx[keep]] = True
        mid, net, e = take(d, m, h)
        rows.append(dict(subset=nm, **stat(net, mid, e),
                         mean_pred=f"{np.abs(pred[keep]).mean():.4f}",
                         mean_cost=f"{spread_atr[idx[keep]].mean():.4f}"))
    table(rows, f"horizon {h} bars")

print("\n" + "=" * 92)
print("STEP 5 — COST-AWARE GATE: trade only when expected move beats its own cost")
print(f"          slippage={SLIPPAGE}  safety margin={MARGIN}")
print("=" * 92)
for h in [6, 12, 24]:
    s = store[h]; dv = s["dv"]; pred = s["r_g"]; p = s["p_g"]
    idx = np.where(dv)[0]
    edge = np.abs(pred) - spread_atr[dv] - SLIPPAGE - MARGIN
    rows = []
    for thr in [0.0, 0.02, 0.05, 0.10]:
        for pconf in [0.50, 0.55, 0.60]:
            conf = np.maximum(p, 1 - p)
            sel = (edge > thr) & (conf >= pconf)
            if sel.sum() < 30:
                continue
            d = np.zeros(len(df)); d[idx[sel]] = np.sign(pred[sel]); d[d == 0] = 1
            m = np.zeros(len(df), dtype=bool); m[idx[sel]] = True
            mid, net, e = take(d, m, h)
            rows.append(dict(edge_thr=thr, p_min=pconf, wait=f"{100*(1-sel.mean()):.1f}%",
                             **stat(net, mid, e)))
    table(rows, f"horizon {h} bars")

print("\n" + "=" * 92)
print("STEP 6 — TIMEFRAME ABLATION (direction gbt, DEV accuracy + gross)")
print("=" * 92)
for h in [6, 24]:
    tr, dv, _ = blocks(h)
    y = (df["midRet%d" % h].to_numpy() > 0).astype(int)
    rows = []
    for nm, groups in (("M15 only", ["m15", "time"]), ("M15+H1", ["m15", "time", "h1"]),
                       ("M15+H4", ["m15", "time", "h4"]), ("M15+H1+H4", ["m15", "time", "h1", "h4"]),
                       ("M15+H1+H4+XS (all)", ["m15", "time", "h1", "h4", "xs"])):
        cols = [FEATS.index(f) for g in groups for f in GROUPS[g]]
        Xg = X_all[:, cols]
        g = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=5,
                                           l2_regularization=1.0, random_state=7).fit(Xg[tr], y[tr])
        pp = g.predict_proba(Xg[dv])[:, 1]
        d = np.zeros(len(df)); d[np.where(dv)[0]] = np.where(pp >= 0.5, 1.0, -1.0)
        mid, net, e = take(d, dv, h)
        rows.append(dict(featureset=nm, nfeat=len(cols), **stat(net, mid, e),
                         logloss=f"{log_loss(y[dv], np.clip(pp,1e-6,1-1e-6)):.4f}"))
    table(rows, f"horizon {h} bars")
print("\ndone")
