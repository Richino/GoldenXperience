"""
reactive-continuation-v1 — TRAIN/DEV ONLY. SEALED NOT READ. RESEARCH ONLY.

Does NOT predict direction. The Big-Move Detector says a large move is likely;
price is then allowed to reveal the direction over a short confirmation window;
only then is the trade joined. The question is whether enough move remains.

TIMELINE, and why each piece is point-in-time safe:
    i        Big-Move signal bar. Detector reads features up to and including i.
    i+1..j   confirmation window. Confirmation reads ONLY bars closed by j.
             Breakout levels come from bars at or BEFORE i.
    j        reactive ENTRY. Fill at ask[j] (long) or bid[j] (short) — both are
             the decision bar's own closing quotes, known at j.
    j+1..j+H forward outcome. Nothing here touches any feature.

FROZEN: the detector is the move-direction-v1 spec (HistGradientBoostingRegressor
on |move|, 250 iters, lr 0.05, depth 5, l2 1.0, seed 7) trained on TRAIN only,
targeting absMove6 as the canonical magnitude. It is NOT retuned here.

Everything is scaled by ATR at the SIGNAL bar i, so "move consumed" and
"remaining move" share one ruler across an episode.
"""
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier

exec(open(os.path.join(os.path.dirname(__file__), "_v3_model.py")).read().split("ABL = [")[0])

OH = pd.read_csv(os.environ["OHLC"])
OH["ts"] = pd.to_datetime(OH["ts"], format="mixed", utc=True).dt.tz_convert(None)
df = df.merge(OH, on=["pair", "ts"], how="inner").sort_values(["pair", "ts"]).reset_index(drop=True)
# _v3_model.py captured module-level ts/pair/spread from the PRE-merge frame.
# Re-sorting by (pair, ts) invalidates them, and blocks()/eff_n() read those
# globals — so the TRAIN/DEV masks would be misaligned with the rows they index,
# silently leaking DEV bars into training. Rebind them to the current frame.
ts = df["ts"].to_numpy()
pair = df["pair"].to_numpy()
spread = df["spreadAtr"].to_numpy()
print(f"rows with prices: {len(df)}  (ts/pair rebound to merged frame)")

MOVE_F = sorted({c for g in ("baseline", "rates", "strength", "struct", "inter") for c in GROUPS[g]})
EXIST_F = sorted({c for g in ("baseline", "rates", "strength") for c in GROUPS[g]})
SLIPA = 0.02
MIN_EFF = int(os.environ.get("MIN_EFF", "200"))
EXITS = [1, 3, 6, 12, 24]
DELAYS = [1, 2, 3, 4]

tr_mask, dv_mask = blocks(6)
X = df[MOVE_F].to_numpy(dtype=np.float64)
det = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_depth=5,
                                    l2_regularization=1.0, random_state=7).fit(X[tr_mask], df["absMove6"].to_numpy()[tr_mask])
df["predMove"] = det.predict(X)
SIG_THR = np.quantile(df["predMove"].to_numpy()[tr_mask], 0.75)   # top quartile, set on TRAIN
print(f"frozen detector: corr(DEV)={np.corrcoef(df['predMove'][dv_mask], df['absMove6'][dv_mask])[0,1]:+.4f}  "
      f"signal threshold (TRAIN p75) = {SIG_THR:.4f}")
# old direction model, for Control A
dc = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_depth=5,
                                    l2_regularization=1.0, random_state=7).fit(
    df[EXIST_F].to_numpy(float)[tr_mask], (df["midRet6"].to_numpy() > 0).astype(int)[tr_mask])
df["pOld"] = dc.predict_proba(df[EXIST_F].to_numpy(float))[:, 1]

# ---- per-pair contiguous arrays -------------------------------------------------
BLK = {}
for p, g in df.groupby("pair", sort=False):
    g = g.sort_values("ts").reset_index(drop=True)
    BLK[p] = dict(
        ts=g["ts"].to_numpy(), o=g["o"].to_numpy(), h=g["h"].to_numpy(), l=g["l"].to_numpy(),
        c=g["c"].to_numpy(), bid=g["bid"].to_numpy(), ask=g["ask"].to_numpy(),
        atr=(g["atrPips"].to_numpy() * (0.01 if p.endswith("JPY") else 0.0001)),
        pm=g["predMove"].to_numpy(), pold=g["pOld"].to_numpy(),
        volpct=g["m15VolPct"].to_numpy(), breadth=g["breadthDiff"].to_numpy() if "breadthDiff" in g else np.zeros(len(g)),
        h1=g["h1Slope"].to_numpy() if "h1Slope" in g else np.zeros(len(g)),
        h4=g["h4Slope"].to_numpy() if "h4Slope" in g else np.zeros(len(g)),
        strd=g["strDiff6"].to_numpy(), dev=(g["ts"].to_numpy() >= np.datetime64(TRAIN_END)) & (g["ts"].to_numpy() < np.datetime64(DEV_END)),
    )
STEP = np.timedelta64(15, "m")


def episodes(delay, family, thr, require_signal=True, invert=False):
    """Build reactive entries. Returns arrays aligned to the ENTRY bar."""
    out = dict(pair=[], j=[], dirn=[], consumed=[], atr=[], ts=[], vol=[], ctx=[])
    for p, B in BLK.items():
        n = len(B["ts"])
        hi20 = pd.Series(B["h"]).rolling(20).max().to_numpy()
        lo20 = pd.Series(B["l"]).rolling(20).min().to_numpy()
        hi10 = pd.Series(B["h"]).rolling(10).max().to_numpy()
        lo10 = pd.Series(B["l"]).rolling(10).min().to_numpy()
        for i in range(25, n - delay - 25):
            if not B["dev"][i]:
                continue
            if require_signal and B["pm"][i] < SIG_THR:
                continue
            if not require_signal and B["pm"][i] >= SIG_THR:
                continue                                   # Control C: matched NON-signal bars
            j = i + delay
            if B["ts"][j] - B["ts"][i] != STEP * delay:      # contiguity, no gap-jumping
                continue
            a = B["atr"][i]
            if not (a > 0):
                continue
            move = (B["c"][j] - B["c"][i]) / a
            d = 0
            if family == "return":
                if move >= thr: d = 1
                elif move <= -thr: d = -1
            elif family == "break20":
                if B["c"][j] > hi20[i]: d = 1
                elif B["c"][j] < lo20[i]: d = -1
            elif family == "break10":
                if B["c"][j] > hi10[i]: d = 1
                elif B["c"][j] < lo10[i]: d = -1
            elif family == "structure":
                if B["c"][j] > hi10[i] and B["l"][j] > B["l"][i]: d = 1
                elif B["c"][j] < lo10[i] and B["h"][j] < B["h"][i]: d = -1
            elif family == "momentum":
                if B["c"][j] > B["o"][j] and B["c"][j-1] > B["o"][j-1]: d = 1
                elif B["c"][j] < B["o"][j] and B["c"][j-1] < B["o"][j-1]: d = -1
            if d == 0:
                continue
            if invert:
                d = -d
            out["pair"].append(p); out["j"].append(j); out["dirn"].append(d)
            out["consumed"].append(abs(move)); out["atr"].append(a); out["ts"].append(B["ts"][j])
            out["vol"].append(B["volpct"][i])
            out["ctx"].append(np.sign(B["breadth"][j]) * d + np.sign(B["h1"][j]) * d + np.sign(B["h4"][j]) * d)
    return {k: np.array(v) for k, v in out.items()}


def outcome(ep, H):
    """Executable + gross outcome from the entry bar, plus remaining excursions."""
    g, nt, mfe, mae = [], [], [], []
    for p, j, d, a in zip(ep["pair"], ep["j"], ep["dirn"], ep["atr"]):
        B = BLK[p]
        if j + H >= len(B["ts"]) or B["ts"][j + H] - B["ts"][j] != STEP * H:
            g.append(np.nan); nt.append(np.nan); mfe.append(np.nan); mae.append(np.nan); continue
        if d > 0:
            gr = (B["c"][j + H] - B["c"][j]) / a
            ne = (B["bid"][j + H] - B["ask"][j]) / a
            up = (np.nanmax(B["h"][j + 1:j + H + 1]) - B["ask"][j]) / a
            dn = (B["ask"][j] - np.nanmin(B["l"][j + 1:j + H + 1])) / a
        else:
            gr = (B["c"][j] - B["c"][j + H]) / a
            ne = (B["bid"][j] - B["ask"][j + H]) / a
            up = (B["bid"][j] - np.nanmin(B["l"][j + 1:j + H + 1])) / a
            dn = (np.nanmax(B["h"][j + 1:j + H + 1]) - B["bid"][j]) / a
        g.append(gr); nt.append(ne); mfe.append(up); mae.append(dn)
    return np.array(g), np.array(nt), np.array(mfe), np.array(mae)


def eff_ep(ep, H):
    """Independent count: thin per pair to one entry every H bars."""
    tot = 0
    for p in np.unique(ep["pair"]):
        t = np.sort(ep["ts"][ep["pair"] == p]).astype("datetime64[m]").astype(np.int64)
        last = -10**18
        for v in t:
            if v - last >= H * 15:
                tot += 1; last = v
    return max(1, tot)


def rep(tag, ep, H, w=30):
    g, nt, mfe, mae = outcome(ep, H)
    ok = ~np.isnan(nt)
    if ok.sum() < 30:
        return None
    g, nt, mfe, mae = g[ok], nt[ok], mfe[ok], mae[ok]
    sub = {k: v[ok] for k, v in ep.items()}
    en = eff_ep(sub, H)
    m = nt.mean(); se = nt.std(ddof=1) / np.sqrt(len(nt)) * (np.sqrt(len(nt) / en) if en < len(nt) else 1.0)
    gp, gl = nt[nt > 0].sum(), -nt[nt < 0].sum()
    return dict(tag=tag, n=len(nt), eff=en, win=(nt > 0).mean(), gross=g.mean(), net=m,
                lo=m - 1.96 * se, hi=m + 1.96 * se, pf=(gp / gl) if gl > 0 else np.inf,
                mfe=mfe.mean(), mae=mae.mean(), consumed=sub["consumed"].mean())


def show(r, w=30):
    if r is None: return
    print(f"  {r['tag']:<{w}}{r['n']:>7}{r['eff']:>7}{r['win']*100:>7.1f}%{r['gross']:>+10.4f}"
          f"{r['net']:>+10.4f} [{r['lo']:+.4f},{r['hi']:+.4f}]{r['pf']:>7.2f}{r['mfe']:>8.2f}{r['mae']:>8.2f}{r['consumed']:>9.2f}")


HDR = (f"  {'setup':<30}{'n':>7}{'eff':>7}{'win':>8}{'gross':>10}{'net':>10}"
       f"{'net 95% CI':>21}{'PF':>7}{'MFE':>8}{'MAE':>8}{'consumed':>9}")
QUAL = []; REG = []

print("\n" + "=" * 140)
print("PHASE 1 — CONFIRMATION FAMILIES x DELAY   (exit h=6, after Big-Move signal)")
print("=" * 140)
FAMS = [("return", 0.10), ("return", 0.20), ("return", 0.30), ("return", 0.50),
        ("break10", 0), ("break20", 0), ("structure", 0), ("momentum", 0)]
CACHE = {}
for fam, thr in FAMS:
    print(f"\n--- {fam}" + (f" >= {thr:.2f} ATR" if fam == "return" else "") + " ---")
    print(HDR)
    for d in DELAYS:
        ep = episodes(d, fam, thr)
        CACHE[(fam, thr, d)] = ep
        if len(ep["j"]) < 50: continue
        r = rep(f"delay {d} bar", ep, 6)
        show(r)
        if r:
            REG.append(dict(fam=fam, thr=thr, delay=d, H=6, **{k: r[k] for k in ("n","eff","net","lo")}))
            if r["net"] > 0 and r["eff"] >= MIN_EFF: QUAL.append(r)

print("\n" + "=" * 140)
print("PHASE 2 — CONTINUATION vs REVERSAL (delay 2, exit h=6)")
print("=" * 140)
print(HDR)
for fam, thr in FAMS:
    ep = CACHE[(fam, thr, 2)]
    if len(ep["j"]) < 50: continue
    label = fam + (f">{thr:.2f}" if fam == "return" else "")
    show(rep(f"{label} CONTINUATION", ep, 6))
    inv = dict(ep); inv["dirn"] = -ep["dirn"]
    show(rep(f"{label} REVERSAL", inv, 6))

print("\n" + "=" * 140)
print("PHASE 3 — MOVE CONSUMED BEFORE ENTRY (return>=0.20, delay 2, exit h=6)")
print("=" * 140)
ep = CACHE[("return", 0.20, 2)]
print(HDR)
for lo_, hi_, nm in ((0, .2, "<0.20 ATR"), (.2, .4, "0.20-0.40"), (.4, .6, "0.40-0.60"),
                     (.6, 1.0, "0.60-1.00"), (1.0, 99, ">1.00 ATR")):
    sel = (ep["consumed"] >= lo_) & (ep["consumed"] < hi_)
    if sel.sum() < 50: continue
    show(rep(nm, {k: v[sel] for k, v in ep.items()}, 6))

print("\n" + "=" * 140)
print("PHASE 4 — EXIT HORIZON SWEEP (return>=0.20, delay 2)")
print("=" * 140)
print(HDR)
for H in EXITS:
    r = rep(f"exit {H} bars", ep, H)
    show(r)
    if r:
        REG.append(dict(fam="return", thr=.2, delay=2, H=H, **{k: r[k] for k in ("n","eff","net","lo")}))
        if r["net"] > 0 and r["eff"] >= MIN_EFF: QUAL.append(r)

print("\n" + "=" * 140)
print("PHASE 5 — CONTROLS")
print("=" * 140)
print(HDR)
show(rep("A: immediate, old direction", dict(CACHE[("return", 0.20, 2)],
        dirn=np.array([1 if BLK[p]["pold"][j] >= .5 else -1 for p, j in
                       zip(ep["pair"], ep["j"])])), 6))
rng = np.random.default_rng(20260822)
show(rep("B: random after confirmation", dict(ep, dirn=rng.choice([-1, 1], size=len(ep["j"]))), 6))
epC = episodes(2, "return", 0.20, require_signal=False)
show(rep("C: same rule, NO big-move sig", epC, 6))

print("\n" + "=" * 140)
print("PHASE 6 — CONTEXT / LONG-SHORT / PAIR / VOLATILITY (return>=0.20, delay 2, exit h=6)")
print("=" * 140)
print(HDR)
for v, nm in ((-3, "context: all 3 disagree"), (-1, "context: net -1"), (1, "context: net +1"), (3, "context: all 3 agree")):
    sel = ep["ctx"] == v
    if sel.sum() >= 50: show(rep(nm, {k: x[sel] for k, x in ep.items()}, 6))
for d, nm in ((1, "LONG only"), (-1, "SHORT only")):
    sel = ep["dirn"] == d
    if sel.sum() >= 50: show(rep(nm, {k: x[sel] for k, x in ep.items()}, 6))
for p in ("EUR_USD", "GBP_USD", "USD_JPY"):
    sel = ep["pair"] == p
    if sel.sum() >= 50: show(rep(p, {k: x[sel] for k, x in ep.items()}, 6))
for lo_, hi_, nm in ((0, .33, "low vol"), (.33, .66, "normal vol"), (.66, .9, "high vol"), (.9, 1.01, "extreme vol")):
    sel = (ep["vol"] >= lo_) & (ep["vol"] < hi_)
    if sel.sum() >= 50: show(rep(nm, {k: x[sel] for k, x in ep.items()}, 6))

print("\n" + "=" * 140)
print(f"DEV GATE — net > 0 with effective n >= {MIN_EFF}")
print("=" * 140)
print(f"  subsets logged: {len(REG)}")
if not QUAL:
    print("  RESULT: NONE qualify.")
else:
    for r in sorted(QUAL, key=lambda x: -x["net"]):
        print(f"   {r['tag']:<30} eff={r['eff']:>5} net={r['net']:+.4f} "
              f"CI=[{r['lo']:+.4f},{r['hi']:+.4f}]  CI>0:{'YES' if r['lo']>0 else 'no'}")
