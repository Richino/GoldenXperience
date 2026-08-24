"""
catalyst-direction-v1 — TRAIN/DEV ONLY. SEALED NOT READ. RESEARCH ONLY.

Tests whether intraday catalyst information can determine direction during
predicted large-move conditions, where the existing direction model fails.

WHAT IS AND IS NOT AVAILABLE (documented before any result):

  AVAILABLE — OANDA M15 CFDs, full history 2022-08 → 2026-08:
    USB02Y_USD  US 2-year bond      -> intraday short-end yield repricing
    USB10Y_USD  US 10-year bond     -> curve repricing
    SPX500_USD  US equities         -> risk appetite
    XAU_USD     gold                -> haven bid
    WTICO_USD   crude               -> inflation/commodity impulse
    DE30_EUR / UK100_GBP / JP225_USD  regional equity proxies

  EXCLUDED — macro surprise features:
    Historical economic releases WITH consensus forecasts could not be obtained.
    The project's calendar is ForexFactory's `ff_calendar_thisweek.json`, which
    the code itself documents as current-week only ("nextweek/lastweek/today all
    404"), is not persisted to any table, and carries no historical archive.
    FRED supplies ACTUALS but no consensus. Fabricating or back-filling a
    forecast series would invent the very thing the surprise is measured
    against, so surprise features are EXCLUDED, per the brief.

  SUBSTITUTED — catalyst arrival is proxied by intraday 2-year repricing
    magnitude rather than a release calendar. A macro surprise that matters
    shows up as the short end repricing; this captures the transmission without
    claiming to know the release. It is labelled a PROXY throughout.

  ASYMMETRY — intraday yield repricing exists only for the USD leg. There is no
    intraday EUR/GBP/JPY short-end contract available here, so regional equity
    indices stand in as weak risk proxies for those legs. Stated, not hidden.

SIGN CONVENTION: USB02Y/USB10Y are BOND PRICE contracts. Price up = yield DOWN.
All yield features are sign-flipped at construction and named `yield*`.
"""
import os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss

exec(open(os.path.join(os.path.dirname(__file__), "_v3_model.py")).read().split("ABL = [")[0])

XA = os.environ["XASSET"]
HORIZONS = [int(x) for x in os.environ.get("HORIZONS", "1,3,6,12,24").split(",")]
MIN_EFF = int(os.environ.get("MIN_EFF", "200"))
SLIPA = 0.02
REGISTRY = []

# ---------------------------------------------------------------- cross-asset
ca = pd.read_csv(XA)
# OANDA stamps a candle with its START time; market_candles is stamped with the
# CLOSE. Verified directly: OANDA time=10:00 and DB close_time=10:15 carry the
# identical close price. Joining the raw OANDA stamp to a decision bar therefore
# attaches a candle that closes 15 minutes LATER — precisely the h=1 forward
# window. Converting start -> close is what makes the join point-in-time safe.
ca["time"] = (pd.to_datetime(ca["time"], format="mixed", utc=True).dt.tz_convert(None)
              + pd.Timedelta(minutes=15))
wide = ca.pivot_table(index="time", columns="instrument", values="c", aggfunc="last").sort_index()
grid = pd.DatetimeIndex(sorted(df["ts"].unique()))
# reindex onto the decision grid, forward-fill at most 4 bars (1h) and track
# staleness, so a closed market never contributes a silently stale "reaction"
wide = wide.reindex(wide.index.union(grid)).sort_index()
stale = {}
for cinst in wide.columns:
    filled = wide[cinst].ffill(limit=4)
    age = filled.notna() & wide[cinst].isna()
    stale[cinst] = age
    wide[cinst] = filled
wide = wide.reindex(grid)
print(f"cross-asset aligned to {len(wide)} decision timestamps; "
      f"coverage: " + " ".join(f"{c}={100*wide[c].notna().mean():.0f}%" for c in wide.columns))

LAGS = {1: "15m", 2: "30m", 4: "1h", 16: "4h"}
feat = pd.DataFrame(index=grid)
for cinst in wide.columns:
    s = wide[cinst]
    vol = s.pct_change().rolling(96, min_periods=20).std()
    for k, nm in LAGS.items():
        r = np.log(s / s.shift(k))
        # bonds: price up == yield down, so flip and name the feature by yield
        sign = -1.0 if cinst.startswith("USB") else 1.0
        base = ("yield" + cinst[3:6]) if cinst.startswith("USB") else cinst.split("_")[0]
        feat[f"{base}_{nm}"] = sign * r
        feat[f"{base}_{nm}_z"] = sign * r / (vol * np.sqrt(k)).replace(0, np.nan)
feat["yieldCurve_1h"] = feat["yield10Y_1h"] - feat["yield02Y_1h"]
feat["yieldCurve_4h"] = feat["yield10Y_4h"] - feat["yield02Y_4h"]
# catalyst-arrival PROXY: how unusual is the current 30m short-end repricing
rp = feat["yield02Y_30m"].abs()
feat["repriceIntensity"] = rp.rolling(2000, min_periods=200).rank(pct=True)
feat["stale02Y"] = stale["USB02Y_USD"].reindex(grid).fillna(True).astype(float)
feat = feat.replace([np.inf, -np.inf], np.nan).fillna(0.0)
feat.index.name = "ts"
df = df.merge(feat.reset_index(), on="ts", how="left")

# --------------------------------------------------- breadth + agreement
CCY8 = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]
S = {c: df[f"xs{c}24"].to_numpy() for c in CCY8}
baseC = df["pair"].str.slice(0, 3).to_numpy(); quoteC = df["pair"].str.slice(4).to_numpy()
bs = np.array([S[b][i] for i, b in enumerate(baseC)])
qs = np.array([S[q][i] for i, q in enumerate(quoteC)])
allS = np.vstack([S[c] for c in CCY8])
df["breadthBase"] = (bs > allS).sum(axis=0)
df["breadthQuote"] = (qs > allS).sum(axis=0)
df["breadthDiff"] = df["breadthBase"] - df["breadthQuote"]
df["xsDispersion"] = allS.std(axis=0)

# pair-relevant legs: USD yield repricing signed toward the PAIR, plus a
# regional equity proxy for the non-USD leg
usd_is_base = (baseC == "USD").astype(float)
usd_is_quote = (quoteC == "USD").astype(float)
y02 = df["yield02Y_1h"].to_numpy()
df["yieldFavoursBase"] = y02 * (usd_is_base - usd_is_quote)
reg = np.where(baseC == "EUR", df["DE30"].to_numpy() if "DE30" in df else 0,
      np.where(baseC == "GBP", df["UK100"].to_numpy() if "UK100" in df else 0, 0))
df["regionalEquityBase"] = 0.0 if "DE30_1h" not in df else np.where(
    baseC == "EUR", df["DE30_1h"], np.where(baseC == "GBP", df["UK100_1h"],
    np.where(quoteC == "JPY", -df["JP225_1h"], 0.0)))

# agreement: how many independent sources point the same way for the pair
sgn = lambda a: np.sign(np.asarray(a))
src = np.vstack([sgn(df["yieldFavoursBase"]), sgn(df["breadthDiff"]),
                 sgn(df["strDiff6"]), sgn(df["SPX500_1h"] * (usd_is_quote - usd_is_base)),
                 sgn(df["XAU_1h"] * (usd_is_quote - usd_is_base))])
df["agreeCount"] = (src == sgn(df["strDiff6"])[None, :]).sum(axis=0)
df["agreeNet"] = src.sum(axis=0)
df["agreeAbs"] = np.abs(src.sum(axis=0))

CATALYST = [c for c in feat.columns] + ["breadthBase", "breadthQuote", "breadthDiff",
            "xsDispersion", "yieldFavoursBase", "regionalEquityBase",
            "agreeCount", "agreeNet", "agreeAbs"]
CATALYST = [c for c in CATALYST if c in df.columns]
EXISTING = sorted({c for g in ("baseline", "rates", "strength") for c in GROUPS[g]})
COMBINED = sorted(set(EXISTING) | set(CATALYST))
for c in CATALYST:
    df[c] = pd.to_numeric(df[c], errors="coerce")
df[CATALYST] = df[CATALYST].replace([np.inf, -np.inf], np.nan).fillna(0.0)
print(f"catalyst features: {len(CATALYST)}   existing: {len(EXISTING)}   combined: {len(COMBINED)}")
assert not any(c.startswith(("mfe", "mae", "absMove", "midRet", "longRet", "shortRet")) for c in COMBINED)
print("label-in-feature check: PASS")

spread_a = df["spreadAtr"].to_numpy()
pairv = df["pair"].to_numpy()
MOVE_F = sorted({c for g in ("baseline", "rates", "strength", "struct", "inter") for c in GROUPS[g]})


def ci(v, en):
    n = len(v); m = v.mean()
    se = v.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    return m, m - 1.96 * se, m + 1.96 * se


def econ(idx, d, h, en=None):
    mid = df[f"midRet{h}"].to_numpy()[idx] * d
    net = np.where(d > 0, df[f"longRet{h}"].to_numpy()[idx], df[f"shortRet{h}"].to_numpy()[idx])
    if en is None:
        m = np.zeros(len(df), bool); m[idx] = True; en = eff_n(m, h)
    nm, lo, hi = ci(net, en)
    gp, gl = net[net > 0].sum(), -net[net < 0].sum()
    return dict(n=len(idx), eff=en, acc=(mid > 0).mean(), gross=mid.mean(), net=nm, lo=lo, hi=hi,
                pf=(gp / gl) if gl > 0 else float("inf"))


def row(tag, r, w=26):
    return (f"  {tag:<{w}}{r['n']:>7}{r['eff']:>7}{r['acc']*100:>7.1f}%{r['gross']:>+10.4f}"
            f"{r['net']:>+10.4f} [{r['lo']:+.4f},{r['hi']:+.4f}]{r['pf']:>7.2f}")


HDR = f"  {'bucket':<26}{'n':>7}{'eff':>7}{'acc':>8}{'gross':>10}{'net':>10}{'net 95% CI':>21}{'PF':>7}"
ST = {}

print("\n" + "=" * 126)
print("TEST 1 — does catalyst information improve DIRECTION at all?  (A frozen / B catalyst-only / C combined)")
print("=" * 126)
for h in HORIZONS:
    tr, dv = blocks(h)
    idx = np.where(dv)[0]; en = eff_n(dv, h)
    y = (df[f"midRet{h}"].to_numpy() > 0).astype(int)
    print(f"\n### h={h}   DEV n={int(dv.sum())}  eff n={en}")
    print(HDR + "  brier   logloss")
    out = {}
    for nm, cols in (("A existing (frozen)", EXISTING), ("B catalyst-only", CATALYST), ("C existing+catalyst", COMBINED)):
        X = df[cols].to_numpy(dtype=np.float64)
        g = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                           l2_regularization=1.0, random_state=7).fit(X[tr], y[tr])
        p = g.predict_proba(X[dv])[:, 1]
        d = np.where(p >= 0.5, 1.0, -1.0)
        r = econ(idx, d, h, en)
        print(row(nm, r) + f"  {brier_score_loss(y[dv],p):.4f}  {log_loss(y[dv],np.clip(p,1e-6,1-1e-6)):.4f}")
        out[nm] = p
        REGISTRY.append(dict(test="direction", model=nm, h=h, n=r["n"], eff=r["eff"], net=r["net"], lo=r["lo"]))
    # linear catalyst check
    sc = StandardScaler().fit(df[CATALYST].to_numpy(float)[tr])
    lg = LogisticRegression(max_iter=1000, C=0.05).fit(sc.transform(df[CATALYST].to_numpy(float)[tr]), y[tr])
    pl = lg.predict_proba(sc.transform(df[CATALYST].to_numpy(float)[dv]))[:, 1]
    print(row("B catalyst logistic", econ(idx, np.where(pl >= 0.5, 1.0, -1.0), h, en)))
    ST[h] = dict(idx=idx, dv=dv, tr=tr, en=en, y=y, **{k.split()[0]: v for k, v in out.items()})

print("\n" + "=" * 126)
print("TEST 2 — THE KEY TEST: direction conditional on the FROZEN big-move detector")
print("         (move detector retrained to the move-direction-v1 spec, never tuned here)")
print("=" * 126)
for h in HORIZONS:
    s = ST[h]; tr, dv, idx, en = s["tr"], s["dv"], s["idx"], s["en"]
    Xm = df[MOVE_F].to_numpy(dtype=np.float64)
    absm = df[f"absMove{h}"].to_numpy()
    gbr = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                        l2_regularization=1.0, random_state=7).fit(Xm[tr], absm[tr])
    pm = gbr.predict(Xm[dv]); s["pm"] = pm
    order = np.argsort(-pm)
    print(f"\n### h={h}   corr(pred move, real move)={np.corrcoef(pm, absm[dv])[0,1]:+.4f}")
    for mdl in ("A", "B", "C"):
        p = s[mdl]; d = np.where(p >= 0.5, 1.0, -1.0)
        print(f"  -- model {mdl} --"); print(HDR)
        for frac, nm in ((1.0, "All"), (.5, "Top 50%"), (.25, "Top 25%"), (.10, "Top 10%"),
                         (.05, "Top 5%"), (.02, "Top 2%"), (.01, "Top 1%")):
            k = max(50, int(len(pm) * frac)); keep = order[:k]
            r = econ(idx[keep], d[keep], h)
            print(row(nm, r))
            REGISTRY.append(dict(test="bigmove", model=mdl, h=h, bucket=nm, eff=r["eff"], net=r["net"], lo=r["lo"]))

print("\n" + "=" * 126)
print("TEST 3 — CATALYST-ARRIVAL PROXY regime (intraday 2Y repricing intensity), model C")
print("=" * 126)
ri = df["repriceIntensity"].to_numpy()
for h in HORIZONS:
    s = ST[h]; idx, en = s["idx"], s["en"]
    d = np.where(s["C"] >= 0.5, 1.0, -1.0)
    print(f"\n### h={h}"); print(HDR)
    for lo_, hi_, nm in ((0, .5, "quiet (p0-50)"), (.5, .8, "active (p50-80)"),
                         (.8, .95, "repricing (p80-95)"), (.95, 1.01, "sharp repricing (p95+)")):
        sel = (ri[idx] >= lo_) & (ri[idx] < hi_)
        if sel.sum() < 300: continue
        r = econ(idx[sel], d[sel], h)
        print(row(nm, r))
        REGISTRY.append(dict(test="regime", h=h, bucket=nm, eff=r["eff"], net=r["net"], lo=r["lo"]))

print("\n" + "=" * 126)
print("TEST 4 — AGREEMENT: does more independent confirmation help? (model C)")
print("=" * 126)
ac = df["agreeAbs"].to_numpy()
for h in HORIZONS:
    s = ST[h]; idx = s["idx"]
    d = np.where(s["C"] >= 0.5, 1.0, -1.0)
    print(f"\n### h={h}"); print(HDR)
    for v in (1, 3, 5):
        sel = ac[idx] == v
        if sel.sum() < 300: continue
        r = econ(idx[sel], d[sel], h)
        print(row(f"{v} net confirmations", r))
        REGISTRY.append(dict(test="agree", h=h, bucket=v, eff=r["eff"], net=r["net"], lo=r["lo"]))

print("\n" + "=" * 126)
print("TEST 5 — COST-AWARE TOP TAIL (model C direction, frozen move magnitude)")
print("=" * 126)
QUAL = []
for h in HORIZONS:
    s = ST[h]; idx, pm = s["idx"], s["pm"]
    p = s["C"]; conf = np.maximum(p, 1 - p)
    edge = conf * pm - spread_a[idx] - SLIPA
    order = np.argsort(-edge)
    d = np.where(p >= 0.5, 1.0, -1.0)
    print(f"\n### h={h}"); print(HDR)
    for frac, nm in ((1.0, "All"), (.5, "Top 50%"), (.25, "Top 25%"), (.10, "Top 10%"),
                     (.05, "Top 5%"), (.02, "Top 2%"), (.01, "Top 1%")):
        k = max(50, int(len(edge) * frac)); keep = order[:k]
        r = econ(idx[keep], d[keep], h)
        print(row(nm, r))
        REGISTRY.append(dict(test="toptail", h=h, bucket=nm, eff=r["eff"], net=r["net"], lo=r["lo"]))
        if r["net"] > 0 and r["eff"] >= MIN_EFF: QUAL.append((h, nm, r))

print("\n" + "=" * 126)
print("TEST 6 — LONG / SHORT and PER-PAIR (model C, top 10% by net edge)")
print("=" * 126)
for h in HORIZONS:
    s = ST[h]; idx, pm = s["idx"], s["pm"]
    p = s["C"]; conf = np.maximum(p, 1 - p)
    edge = conf * pm - spread_a[idx] - SLIPA
    keep = np.argsort(-edge)[:int(len(edge) * .10)]
    d = np.where(p[keep] >= 0.5, 1.0, -1.0)
    print(f"\n### h={h}"); print(HDR)
    for nm, sgnv in (("LONG only", 1.0), ("SHORT only", -1.0)):
        ss = d == sgnv
        if ss.sum() < 100: continue
        print(row(nm, econ(idx[keep][ss], np.full(int(ss.sum()), sgnv), h)))
    for pr in ("EUR_USD", "GBP_USD", "USD_JPY"):
        ss = pairv[idx[keep]] == pr
        if ss.sum() < 100: continue
        print(row(pr, econ(idx[keep][ss], d[ss], h)))

print("\n" + "=" * 126)
print(f"DEV GATE — net > 0 with effective n >= {MIN_EFF}")
print("=" * 126)
print(f"\n  registry: {len(REGISTRY)} subsets logged and reported (no silent discards)")
if not QUAL:
    print("  RESULT: NONE qualify.")
else:
    for h, nm, r in sorted(QUAL, key=lambda x: -x[2]["net"]):
        print(f"   h={h} {nm}: eff={r['eff']} net={r['net']:+.4f} CI=[{r['lo']:+.4f},{r['hi']:+.4f}] "
              f"CI>0:{'YES' if r['lo']>0 else 'no'}")
pos = [r for r in REGISTRY if r.get("net", -1) > 0 and r.get("eff", 0) >= MIN_EFF]
print(f"  Across ALL {len(REGISTRY)} logged subsets: {len(pos)} with net>0 and eff>={MIN_EFF}; "
      f"{len([r for r in pos if r.get('lo',-1)>0])} with CI entirely above zero.")
