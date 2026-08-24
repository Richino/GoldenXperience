"""
direction-return-v2 — corrected magnitude model and the cost-wall arithmetic.

Fixes a methodological error in the first pass: expected MAGNITUDE was taken as
|E[signed return]|, but a signed regressor shrinks toward the conditional mean,
which is near zero. |E[X]| is not E[|X|], and using the former as a magnitude
estimate understates the move by an order of magnitude. Magnitude is now
predicted directly from the absMove labels.

That correction also reframes the problem. Expected gross return decomposes as

    E[gross] = (2p - 1) x E[|move|]

so with a realised average absolute move of about 1.25 ATR at six bars against a
0.23 ATR spread, the question is not whether moves are big enough — they are
more than five times the spread. It is purely whether direction can be called
often enough. That gives a single decisive number: the accuracy required to
break even.
"""
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance

PATH = os.environ.get("DATA", "dirmove.csv")
SLIP = float(os.environ.get("SLIPPAGE", "0.02"))
MARGIN = float(os.environ.get("MARGIN", "0.05"))

df = pd.read_csv(PATH)
df["ts"] = pd.to_datetime(df["ts"], format="mixed", utc=True).dt.tz_convert(None)
df = df.sort_values("ts").reset_index(drop=True)
TRAIN_END, DEV_END = pd.Timestamp("2024-08-01"), pd.Timestamp("2025-08-01")
LABEL_P = ("midRet", "absMove", "longRet", "shortRet", "mfe", "mae")
FEATS = [c for c in df.columns if c not in {"pair", "ts"} and not c.startswith(LABEL_P)]
X = np.nan_to_num(df[FEATS].to_numpy(dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
ts, pair = df["ts"].to_numpy(), df["pair"].to_numpy()
spread = df["spreadAtr"].to_numpy()


def blocks(h):
    emb = pd.Timedelta(minutes=15 * h)
    return (ts < np.datetime64(TRAIN_END - emb),
            (ts >= np.datetime64(TRAIN_END)) & (ts < np.datetime64(DEV_END - emb)))


def eff_n(mask, h):
    tot = 0
    for p in np.unique(pair[mask]):
        t = np.sort(ts[mask & (pair == p)]).astype("datetime64[m]").astype(np.int64)
        last = -10**18
        for v in t:
            if v - last >= h * 15:
                tot += 1; last = v
    return max(1, tot)


def table(rows, title):
    print(f"\n--- {title} ---")
    if not rows: print("(none)"); return
    keys = list(rows[0].keys())
    w = {k: max(len(str(k)), max(len(str(r.get(k, ""))) for r in rows)) for k in keys}
    print("  ".join(str(k).ljust(w[k]) for k in keys))
    for r in rows: print("  ".join(str(r.get(k, "")).ljust(w[k]) for k in keys))


print("=" * 96)
print("THE COST WALL, STATED EXACTLY")
print("=" * 96)
print("  E[gross] = (2p - 1) x E[|move|].  Break-even needs (2p-1)*E[|move|] > cost,")
print("  i.e. p > (1 + cost/E[|move|]) / 2.   cost = spread + slippage + margin.\n")
rows = []
for h in [1, 3, 6, 12, 24]:
    tr, dv = blocks(h)
    absm = df["absMove%d" % h].to_numpy()[dv].mean()
    cost = spread[dv].mean() + SLIP + MARGIN
    need = (1 + cost / absm) / 2
    y = (df["midRet%d" % h].to_numpy() > 0).astype(int)
    g = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                       l2_regularization=1.0, random_state=7).fit(X[tr], y[tr])
    p = g.predict_proba(X[dv])[:, 1]
    acc = ((p >= 0.5).astype(int) == y[dv]).mean()
    rows.append(dict(h=h, mean_abs_move=f"{absm:.3f}", cost=f"{cost:.3f}",
                     req_accuracy=f"{need*100:.1f}%", achieved=f"{acc*100:.1f}%",
                     gap=f"{(need-acc)*100:+.1f}pp",
                     req_edge=f"{(2*need-1):.4f}", achieved_edge=f"{(2*acc-1):.4f}"))
table(rows, "accuracy needed vs accuracy achieved (DEV)")

print("\n" + "=" * 96)
print("MAGNITUDE MODEL, DONE PROPERLY — regressor trained on |move|, not on signed return")
print("=" * 96)
store = {}
for h in [6, 24]:
    tr, dv = blocks(h)
    ya = df["absMove%d" % h].to_numpy()
    yd = (df["midRet%d" % h].to_numpy() > 0).astype(int)
    rg = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                       l2_regularization=1.0, random_state=7).fit(X[tr], ya[tr])
    cg = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(X[tr], yd[tr])
    pa, pp = rg.predict(X[dv]), cg.predict_proba(X[dv])[:, 1]
    store[h] = (pa, pp, dv)
    corr = np.corrcoef(pa, ya[dv])[0, 1]
    print(f"\n  h={h}: corr(predicted |move|, realised |move|) = {corr:+.4f}")
    qs = np.quantile(pa, [0, .5, .75, .9, .95, .99, 1.0])
    rows = []
    for lo, hi, nm in zip(qs[:-1], qs[1:], ["p0-50", "p50-75", "p75-90", "p90-95", "p95-99", "p99-100"]):
        sel = (pa >= lo) & ((pa < hi) if hi < qs[-1] else (pa <= hi))
        if sel.sum() < 50: continue
        rows.append(dict(bucket=nm, n=int(sel.sum()), pred=f"{pa[sel].mean():.3f}",
                         realised=f"{ya[dv][sel].mean():.3f}",
                         ratio=f"{ya[dv][sel].mean()/max(pa[sel].mean(),1e-9):.2f}",
                         cost=f"{spread[dv][sel].mean():.3f}",
                         move_over_cost=f"{ya[dv][sel].mean()/max(spread[dv][sel].mean(),1e-9):.1f}x"))
    table(rows, f"h={h} magnitude calibration — is E[|move|] predictable?")

print("\n" + "=" * 96)
print("CONFIDENCE x MAGNITUDE — the combination the whole design rests on (DEV)")
print("=" * 96)
for h in [6, 24]:
    pa, pp, dv = store[h]
    idx = np.where(dv)[0]
    conf = np.maximum(pp, 1 - pp)
    mq = np.quantile(pa, [0.5, 0.85])
    rows = []
    for clo, chi, cn in ((0.50, 0.55, "50-55%"), (0.55, 0.60, "55-60%"),
                         (0.60, 0.65, "60-65%"), (0.65, 1.01, "65%+")):
        for mlo, mhi, mn in ((0, mq[0], "small"), (mq[0], mq[1], "medium"), (mq[1], 1e9, "large")):
            sel = (conf >= clo) & (conf < chi) & (pa >= mlo) & (pa < mhi)
            if sel.sum() < 100: continue
            d = np.where(pp[sel] >= 0.5, 1.0, -1.0)
            mid = df["midRet%d" % h].to_numpy()[idx[sel]] * d
            net = np.where(d > 0, df["longRet%d" % h].to_numpy()[idx[sel]],
                           df["shortRet%d" % h].to_numpy()[idx[sel]])
            sub = np.zeros(len(df), dtype=bool); sub[idx[sel]] = True
            en = eff_n(sub, h)
            se = net.std(ddof=1) / np.sqrt(len(net)) * (np.sqrt(len(net) / en) if en < len(net) else 1)
            rows.append(dict(conf=cn, move=mn, n=int(sel.sum()), eff=en,
                             acc=f"{(mid>0).mean()*100:.1f}%", gross=f"{mid.mean():+.4f}",
                             net=f"{net.mean():+.4f}",
                             ci=f"[{net.mean()-1.96*se:+.4f},{net.mean()+1.96*se:+.4f}]"))
    table(rows, f"horizon {h} bars")

print("\n" + "=" * 96)
print("BEST-CASE CEILING — what if magnitude selection were PERFECT? (oracle, DEV)")
print("=" * 96)
print("  Keeps the bars whose REALISED |move| is largest, which no model can know in")
print("  advance. It is an upper bound on what any magnitude model could deliver.\n")
rows = []
for h in [6, 24]:
    tr, dv = blocks(h)
    ya = df["absMove%d" % h].to_numpy()[dv]
    yd = (df["midRet%d" % h].to_numpy() > 0).astype(int)
    cg = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(X[tr], yd[tr])
    pp = cg.predict_proba(X[dv])[:, 1]
    idx = np.where(dv)[0]
    for frac in (1.0, 0.25, 0.10):
        k = int(len(ya) * frac)
        keep = np.argsort(-ya)[:k]
        d = np.where(pp[keep] >= 0.5, 1.0, -1.0)
        mid = df["midRet%d" % h].to_numpy()[idx[keep]] * d
        net = np.where(d > 0, df["longRet%d" % h].to_numpy()[idx[keep]],
                       df["shortRet%d" % h].to_numpy()[idx[keep]])
        sub = np.zeros(len(df), dtype=bool); sub[idx[keep]] = True
        en = eff_n(sub, h)
        se = net.std(ddof=1) / np.sqrt(len(net)) * (np.sqrt(len(net) / en) if en < len(net) else 1)
        rows.append(dict(h=h, subset=f"top {int(frac*100)}% by REALISED move", n=k, eff=en,
                         acc=f"{(mid>0).mean()*100:.1f}%", mean_move=f"{ya[keep].mean():.3f}",
                         gross=f"{mid.mean():+.4f}", net=f"{net.mean():+.4f}",
                         ci=f"[{net.mean()-1.96*se:+.4f},{net.mean()+1.96*se:+.4f}]"))
table(rows, "oracle magnitude selection (upper bound, not achievable)")

print("\n" + "=" * 96)
print("FEATURE IMPORTANCE — direction model, permutation on DEV, h=6")
print("=" * 96)
h = 6
tr, dv = blocks(h)
yd = (df["midRet%d" % h].to_numpy() > 0).astype(int)
cg = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=5,
                                    l2_regularization=1.0, random_state=7).fit(X[tr], yd[tr])
sub = np.where(dv)[0][:10000]
imp = permutation_importance(cg, X[sub], yd[sub], n_repeats=5, random_state=7, scoring="neg_log_loss")
order = np.argsort(-imp.importances_mean)[:20]
def grp(f):
    if f.startswith("h1"): return "H1"
    if f.startswith("h4"): return "H4"
    if f.startswith("xs"): return "cross-pair"
    if f.startswith("sess") or f in ("hour", "dow"): return "session/time"
    if "Ema" in f: return "EMA-derived"
    return "M15"
table([dict(rank=i+1, feature=FEATS[j], group=grp(FEATS[j]),
            importance=f"{imp.importances_mean[j]:+.5f}") for i, j in enumerate(order)],
      "top 20")
