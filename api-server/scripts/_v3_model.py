"""
direction-return-v3 — modelling and ablation. TRAIN/DEV ONLY. RESEARCH ONLY.

Joins the frozen direction-return-v2 dataset (untouched) with:
  rates    point-in-time policy/overnight rates, joined on availableAt
  strength improved 8-currency cross-sectional strength
  struct   deterministic H1/H4 market structure + timeframe agreement
  inter    a small interpretable set of rate x price and volatility x signal terms

Selection happens on DEV only. The sealed year is not read by this script at all.
Primary objective is NET expectancy after cost, never accuracy.
"""
import os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.inspection import permutation_importance

BASE = os.environ["BASE"]; NEW = os.environ["NEW"]; RATES = os.environ["RATES"]
SLIP = float(os.environ.get("SLIPPAGE", "0.02"))
MARGIN = float(os.environ.get("MARGIN", "0.05"))
HS = [int(x) for x in os.environ.get("HORIZONS", "6,12,24").split(",")]

df = pd.read_csv(BASE)
nf = pd.read_csv(NEW)
df["ts"] = pd.to_datetime(df["ts"], format="mixed", utc=True).dt.tz_convert(None)
nf["ts"] = pd.to_datetime(nf["ts"], format="mixed", utc=True).dt.tz_convert(None)
df = df.merge(nf, on=["pair", "ts"], how="inner", suffixes=("", "_v3")).sort_values("ts").reset_index(drop=True)
print(f"joined rows={len(df)}")

# ---------- point-in-time rates -------------------------------------------
rt = pd.read_json(RATES, lines=True)
rt["availableAt"] = pd.to_datetime(rt["availableAt"], utc=True).dt.tz_convert(None)
panel = {}
for (ccy, kind), g in rt.groupby(["currency", "kind"]):
    g = g.sort_values("availableAt")[["availableAt", "value"]].drop_duplicates("availableAt")
    panel[(ccy, kind)] = g.rename(columns={"value": f"{ccy}_{kind}"})

df = df.sort_values("ts")
for key, g in panel.items():
    # merge_asof takes the last observation whose availableAt <= ts: PIT by construction
    df = pd.merge_asof(df, g, left_on="ts", right_on="availableAt", direction="backward")
    df = df.drop(columns=["availableAt"])

BASECCY = df["pair"].str.slice(0, 3)
QUOTECCY = df["pair"].str.slice(4)
pol = {c: df[f"{c}_policy"] for c in ["USD", "EUR", "GBP", "JPY"]}
df["rateBase"] = np.select([BASECCY == c for c in pol], [pol[c] for c in pol], np.nan)
df["rateQuote"] = np.select([QUOTECCY == c for c in pol], [pol[c] for c in pol], np.nan)
df["rateDiff"] = df["rateBase"] - df["rateQuote"]
df["usd2y"] = df["USD_yield2y"]

# daily-resolution derivatives, computed per pair on the DAILY series then mapped
df["date"] = df["ts"].dt.floor("D")
daily = df.groupby(["pair", "date"], as_index=False)["rateDiff"].last().sort_values(["pair", "date"])
for lag, nm in ((1, "1d"), (5, "5d"), (20, "20d")):
    daily[f"rateDiffChg{nm}"] = daily.groupby("pair")["rateDiff"].diff(lag)
daily["rateDiffAccel"] = daily["rateDiffChg5d"] - daily.groupby("pair")["rateDiffChg5d"].shift(5)
daily["rateDiffMean20"] = daily.groupby("pair")["rateDiff"].transform(lambda s: s.rolling(20, min_periods=5).mean())
daily["rateDiffMean60"] = daily.groupby("pair")["rateDiff"].transform(lambda s: s.rolling(60, min_periods=10).mean())
daily["rateDiffStd60"] = daily.groupby("pair")["rateDiff"].transform(lambda s: s.rolling(60, min_periods=10).std())
daily["rateDiffZ"] = (daily["rateDiff"] - daily["rateDiffMean60"]) / daily["rateDiffStd60"].replace(0, np.nan)
daily["rateDiffFrom20"] = daily["rateDiff"] - daily["rateDiffMean20"]
daily["rateDiffFrom60"] = daily["rateDiff"] - daily["rateDiffMean60"]
RATECOLS = ["rateDiffChg1d", "rateDiffChg5d", "rateDiffChg20d", "rateDiffAccel",
            "rateDiffZ", "rateDiffFrom20", "rateDiffFrom60"]
df = df.merge(daily[["pair", "date"] + RATECOLS], on=["pair", "date"], how="left")
RATE_FEATS = ["rateBase", "rateQuote", "rateDiff", "usd2y"] + RATECOLS

# ---------- volatility regime + a small interaction set -------------------
df["volRegime"] = np.where(df["m15VolPct"] < 0.33, -1.0, np.where(df["m15VolPct"] > 0.66, 1.0, 0.0))
df["volExpanding"] = (df["m15VolExp"] > 1.05).astype(float)
df["ix_mom_x_rate"] = np.sign(df["m15Ret6"]) * df["rateDiffChg5d"].fillna(0)
df["ix_str_x_rate"] = df["strDiff6"] * df["rateDiffChg5d"].fillna(0)
df["ix_h1_x_rate"] = np.sign(df["h1Slope"]) * df["rateDiffChg5d"].fillna(0)
df["ix_h4_x_carry"] = np.sign(df["h4Slope"]) * df["rateDiff"].fillna(0)
df["ix_rate_x_vol"] = df["rateDiffChg5d"].fillna(0) * df["volRegime"]
df["ix_str_x_vol"] = df["strDiff6"] * df["volRegime"]
df["ix_h1_x_vol"] = df["h1Slope"] * df["volRegime"]
INTER_FEATS = ["volRegime", "volExpanding", "ix_mom_x_rate", "ix_str_x_rate",
               "ix_h1_x_rate", "ix_h4_x_carry", "ix_rate_x_vol", "ix_str_x_vol", "ix_h1_x_vol"]

LABEL_P = ("midRet", "absMove", "longRet", "shortRet", "mfe", "mae")
DROP = {"pair", "ts", "date"} | {c for c in df.columns if c.endswith("_policy") or c.endswith("_yield2y")}
ALL = [c for c in df.columns if c not in DROP and not c.startswith(LABEL_P)]
BASELINE = [c for c in ALL if c in pd.read_csv(BASE, nrows=1).columns]
STRENGTH = [c for c in ALL if c.startswith("str")]
STRUCT = [c for c in ALL if c.startswith(("h1H", "h1L", "h1Dist", "h1Break", "h1Slope", "h1Eff",
                                          "h4H", "h4L", "h4Dist", "h4Break", "h4Slope", "h4Eff", "agree"))]
GROUPS = {"baseline": BASELINE, "rates": RATE_FEATS, "strength": [c for c in STRENGTH if c not in BASELINE],
          "struct": [c for c in STRUCT if c not in BASELINE], "inter": INTER_FEATS}
for k, v in GROUPS.items():
    print(f"  group {k:<10} {len(v)}")

for c in ALL:
    df[c] = pd.to_numeric(df[c], errors="coerce")
df[ALL] = df[ALL].replace([np.inf, -np.inf], np.nan).fillna(0.0)

ts = df["ts"].to_numpy(); pair = df["pair"].to_numpy(); spread = df["spreadAtr"].to_numpy()
TRAIN_END, DEV_END = pd.Timestamp("2024-08-01"), pd.Timestamp("2025-08-01")


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


def summarise(name, d, mask, h, en=None):
    sel = d[mask] != 0
    n = int(sel.sum())
    if n < 2:
        return dict(model=name, n=n)
    dd = d[mask][sel]
    mid = df[f"midRet{h}"].to_numpy()[mask][sel] * dd
    net = np.where(dd > 0, df[f"longRet{h}"].to_numpy()[mask][sel], df[f"shortRet{h}"].to_numpy()[mask][sel])
    if en is None:
        sub = np.zeros(len(df), dtype=bool); sub[np.where(mask)[0][sel]] = True
        en = eff_n(sub, h)
    m = net.mean(); se = net.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    gp, gl = net[net > 0].sum(), -net[net < 0].sum()
    return dict(model=name, n=n, eff=en, wait=f"{100*(1-sel.mean()):.0f}%",
                acc=f"{(mid>0).mean()*100:.1f}%", gross=f"{mid.mean():+.4f}", net=f"{m:+.4f}",
                ci=f"[{m-1.96*se:+.4f},{m+1.96*se:+.4f}]", pf=f"{gp/gl:.2f}" if gl > 0 else "inf")


def table(rows, title):
    print(f"\n--- {title} ---")
    rows = [r for r in rows if r]
    if not rows: print("(none)"); return
    keys = list(rows[0].keys())
    w = {k: max(len(str(k)), max(len(str(r.get(k, ""))) for r in rows)) for k in keys}
    print("  ".join(str(k).ljust(w[k]) for k in keys))
    for r in rows: print("  ".join(str(r.get(k, "")).ljust(w[k]) for k in keys))


ABL = [("baseline only", ["baseline"]),
       ("+ rates", ["baseline", "rates"]),
       ("+ strength", ["baseline", "strength"]),
       ("+ H1/H4 struct", ["baseline", "struct"]),
       ("+ rates + strength", ["baseline", "rates", "strength"]),
       ("FULL (all groups)", ["baseline", "rates", "strength", "struct", "inter"])]

print("\n" + "=" * 104)
print("ABLATION — direction gbt, TRAIN -> DEV.  Objective is NET, not accuracy.")
print("=" * 104)
best = {}
for h in HS:
    tr, dv = blocks(h)
    y = (df[f"midRet{h}"].to_numpy() > 0).astype(int)
    en = eff_n(dv, h)
    rows = []
    for nm, gs in ABL:
        cols = sorted({c for g in gs for c in GROUPS[g]})
        Xg = df[cols].to_numpy(dtype=np.float64)
        g = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                           l2_regularization=1.0, random_state=7).fit(Xg[tr], y[tr])
        p = g.predict_proba(Xg[dv])[:, 1]
        d = np.zeros(len(df)); d[np.where(dv)[0]] = np.where(p >= 0.5, 1.0, -1.0)
        r = summarise(nm, d, dv, h, en)
        r["nfeat"] = len(cols)
        r["logloss"] = f"{log_loss(y[dv], np.clip(p,1e-6,1-1e-6)):.4f}"
        r["brier"] = f"{brier_score_loss(y[dv], p):.4f}"
        rows.append(r)
        if nm == "FULL (all groups)":
            best[h] = (cols, p, dv, tr, y, en)
    table(rows, f"horizon {h} bars ({h*15}m)  eff_n={en}")

print("\n" + "=" * 104)
print("RETURN MODEL (Model C) + COST-AWARE GATE")
print("=" * 104)
for h in HS:
    cols, p, dv, tr, y, en = best[h]
    Xg = df[cols].to_numpy(dtype=np.float64)
    yr = df[f"midRet{h}"].to_numpy()
    sc = StandardScaler().fit(Xg[tr])
    ridge = Ridge(alpha=10.0).fit(sc.transform(Xg[tr]), yr[tr])
    gbr = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(Xg[tr], yr[tr])
    pr_r, pr_g = ridge.predict(sc.transform(Xg[dv])), gbr.predict(Xg[dv])
    print(f"\n  h={h}  corr(pred,real): ridge={np.corrcoef(pr_r,yr[dv])[0,1]:+.4f}  "
          f"gbt={np.corrcoef(pr_g,yr[dv])[0,1]:+.4f}   "
          f"MAE: ridge={np.abs(pr_r-yr[dv]).mean():.4f} gbt={np.abs(pr_g-yr[dv]).mean():.4f}  "
          f"(realised |move| = {np.abs(yr[dv]).mean():.4f})")
    idx = np.where(dv)[0]
    # direction from expected return sign; probability is confidence only
    edge = np.abs(pr_g) - spread[dv] - SLIP - MARGIN
    rows = []
    for frac, nm in ((1.0, "all"), (.5, "top 50%"), (.25, "top 25%"), (.10, "top 10%"),
                     (.05, "top 5%"), (.02, "top 2%"), (.01, "top 1%")):
        k = max(30, int(len(edge) * frac))
        keep = np.argsort(-edge)[:k]
        d = np.zeros(len(df)); d[idx[keep]] = np.sign(pr_g[keep]); d[d == 0] = 1
        m = np.zeros(len(df), dtype=bool); m[idx[keep]] = True
        rows.append(summarise(nm, d, m, h))
    table(rows, f"TOP-TAIL by predictedNetEdge — horizon {h}")

print("\n" + "=" * 104)
print("CONFIDENCE x PREDICTED-MOVE (DEV, FULL model)")
print("=" * 104)
for h in HS:
    cols, p, dv, tr, y, en = best[h]
    Xg = df[cols].to_numpy(dtype=np.float64)
    yr = df[f"midRet{h}"].to_numpy()
    gbr = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(Xg[tr], yr[tr])
    pr = gbr.predict(Xg[dv]); idx = np.where(dv)[0]
    conf = np.maximum(p, 1 - p); q = np.quantile(np.abs(pr), [.5, .8, .95])
    rows = []
    for clo, chi, cn in ((.50, .55, "50-55"), (.55, .60, "55-60"), (.60, .65, "60-65"), (.65, 1.01, "65+")):
        for mlo, mhi, mn in ((0, q[0], "small"), (q[0], q[1], "medium"), (q[1], q[2], "large"), (q[2], 1e9, "v.large")):
            sel = (conf >= clo) & (conf < chi) & (np.abs(pr) >= mlo) & (np.abs(pr) < mhi)
            if sel.sum() < 150: continue
            d = np.zeros(len(df)); d[idx[sel]] = np.sign(pr[sel]); d[d == 0] = 1
            m = np.zeros(len(df), dtype=bool); m[idx[sel]] = True
            r = summarise(f"{cn} / {mn}", d, m, h); r.pop("wait", None)
            rows.append(r)
    table(rows, f"horizon {h}")

print("\n" + "=" * 104)
print("LONG vs SHORT (DEV, FULL model, direction from expected return)")
print("=" * 104)
for h in HS:
    cols, p, dv, tr, y, en = best[h]
    Xg = df[cols].to_numpy(dtype=np.float64); yr = df[f"midRet{h}"].to_numpy()
    gbr = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(Xg[tr], yr[tr])
    pr = gbr.predict(Xg[dv]); idx = np.where(dv)[0]
    rows = []
    for side, sgn in (("LONG", 1), ("SHORT", -1)):
        sel = np.sign(pr) == sgn
        if sel.sum() < 50: continue
        d = np.zeros(len(df)); d[idx[sel]] = sgn
        m = np.zeros(len(df), dtype=bool); m[idx[sel]] = True
        r = summarise(f"h={h} {side}", d, m, h); r.pop("wait", None)
        rows.append(r)
    table(rows, f"horizon {h}")

print("\n" + "=" * 104)
print("FEATURE IMPORTANCE + GROUP ABLATION (FULL model, h=%d)" % HS[0])
print("=" * 104)
h = HS[0]
cols, p, dv, tr, y, en = best[h]
Xg = df[cols].to_numpy(dtype=np.float64)
g = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=5,
                                   l2_regularization=1.0, random_state=7).fit(Xg[tr], y[tr])
sub = np.where(dv)[0][:10000]
imp = permutation_importance(g, Xg[sub], y[sub], n_repeats=5, random_state=7, scoring="neg_log_loss")
order = np.argsort(-imp.importances_mean)[:20]
def grp(f):
    for k in ("rates", "strength", "struct", "inter"):
        if f in GROUPS[k]: return k
    return "baseline"
table([dict(rank=i+1, feature=cols[j], group=grp(cols[j]), importance=f"{imp.importances_mean[j]:+.5f}")
       for i, j in enumerate(order)], "top 20")
print("\ndone")
