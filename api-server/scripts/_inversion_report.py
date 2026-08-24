"""
Four-family direction inversion audit — analysis. TRAIN+DEV ONLY. SEALED NOT READ.

Primary hypothesis, unconditional: flip every direction the four engines choose.
No conditional inversion is searched until unconditional inversion is settled.
"""
import os
import numpy as np
import pandas as pd

df = pd.read_csv(os.environ["DATA"])
df["ts"] = pd.to_datetime(df["ts"], format="mixed", utc=True).dt.tz_convert(None)
df = df.sort_values("ts").reset_index(drop=True)
FAMS = ["ema", "breakout", "momentum", "meanrev"]
PURGE_BARS = 24          # signals overlap; thin to one per 6h per family+pair


def eff_n(sub):
    tot = 0
    for (_, _), g in sub.groupby(["family", "pair"], sort=False):
        t = np.sort(g["ts"].to_numpy()).astype("datetime64[m]").astype(np.int64)
        last = -10**18
        for v in t:
            if v - last >= PURGE_BARS * 15:
                tot += 1; last = v
    return max(1, tot)


def stats(sub, col):
    v = sub[col].to_numpy()
    n = len(v)
    if n < 2:
        return None
    en = eff_n(sub)
    m = v.mean(); se = v.std(ddof=1) / np.sqrt(n) * (np.sqrt(n / en) if en < n else 1.0)
    gp, gl = v[v > 0].sum(), -v[v < 0].sum()
    return dict(n=n, eff=en, win=(v > 0).mean(), exp=m, lo=m - 1.96 * se, hi=m + 1.96 * se,
                pf=(gp / gl) if gl > 0 else np.inf)


def line(tag, r, w=26):
    if r is None: return
    print(f"  {tag:<{w}}{r['n']:>7}{r['eff']:>7}{r['win']*100:>8.1f}%{r['exp']:>+10.4f}"
          f" [{r['lo']:+.4f},{r['hi']:+.4f}]{r['pf']:>7.2f}")


HDR = f"  {'':<26}{'n':>7}{'eff':>7}{'win':>9}{'net R':>10}{'95% CI':>21}{'PF':>7}"

print("=" * 110)
print("CORRECTNESS CHECK — the inverted arm must NOT be a negated original")
print("=" * 110)
d = df["oNetR"].to_numpy() + df["iNetR"].to_numpy()
print(f"  mean(oNetR + iNetR)   = {d.mean():+.4f}   (exact negation would give 0.0000)")
print(f"  share where |sum|<1e-9 = {100*(np.abs(d)<1e-9).mean():.1f}%   (exact negation would give 100%)")
g = df["oGrossR"].to_numpy() + df["iGrossR"].to_numpy()
print(f"  mean(oGrossR + iGrossR) = {g.mean():+.4f}   (mid-priced twins, near-symmetric by design)")
print(f"  => both arms independently pay the spread; inversion is NOT a sign flip.  "
      f"{'PASS' if (np.abs(d) < 1e-9).mean() < 0.5 else 'FAIL'}")

print("\n" + "=" * 110)
print("HEADLINE — original vs inverted, per family (TRAIN+DEV 2022-08 -> 2025-08)")
print("=" * 110)
print(f"  {'family':<12}{'n':>7}{'eff':>7}  {'ORIG win':>9}{'ORIG net':>10}  {'INV win':>9}{'INV net':>10}"
      f"{'INV 95% CI':>22}{'INV PF':>8}")
head = {}
for f in FAMS:
    s = df[df.family == f]
    o, iv = stats(s, "oNetR"), stats(s, "iNetR")
    head[f] = (o, iv)
    print(f"  {f:<12}{o['n']:>7}{o['eff']:>7}  {o['win']*100:>8.1f}%{o['exp']:>+10.4f}  "
          f"{iv['win']*100:>8.1f}%{iv['exp']:>+10.4f} [{iv['lo']:+.4f},{iv['hi']:+.4f}]{iv['pf']:>8.2f}")
o, iv = stats(df, "oNetR"), stats(df, "iNetR")
print(f"  {'ALL FOUR':<12}{o['n']:>7}{o['eff']:>7}  {o['win']*100:>8.1f}%{o['exp']:>+10.4f}  "
      f"{iv['win']*100:>8.1f}%{iv['exp']:>+10.4f} [{iv['lo']:+.4f},{iv['hi']:+.4f}]{iv['pf']:>8.2f}")

print("\n" + "=" * 110)
print("GROSS vs NET — is the direction wrong, or is it noise, or is it costs?")
print("=" * 110)
print(f"  {'family':<12}{'ORIG gross':>12}{'INV gross':>12}{'cost':>10}{'ORIG net':>11}{'INV net':>11}   interpretation")
for f in FAMS:
    s = df[df.family == f]
    og, ig = s["oGrossR"].mean(), s["iGrossR"].mean()
    on, inn = s["oNetR"].mean(), s["iNetR"].mean()
    cost = og - on
    if ig > 0.05: interp = "A: systematically wrong"
    elif abs(ig) <= 0.05: interp = "B: essentially noise"
    else: interp = "C: original has information"
    print(f"  {f:<12}{og:>+12.4f}{ig:>+12.4f}{cost:>10.4f}{on:>+11.4f}{inn:>+11.4f}   {interp}")

print("\n" + "=" * 110)
print("PER-FAMILY DETAIL")
print("=" * 110)
for f in FAMS:
    s = df[df.family == f]
    print(f"\n### {f.upper()}   n={len(s)}")
    print(HDR)
    line("ORIGINAL (net)", stats(s, "oNetR"))
    line("INVERTED (net)", stats(s, "iNetR"))
    line("ORIGINAL (gross)", stats(s, "oGrossR"))
    line("INVERTED (gross)", stats(s, "iGrossR"))

print("\n" + "=" * 110)
print("WIN/LOSS TRANSITION MATRIX and WHAT HAPPENS TO ORIGINAL LOSSES (descriptive only)")
print("=" * 110)
for f in FAMS:
    s = df[df.family == f]
    ow, iw = s["oNetR"] > 0, s["iNetR"] > 0
    print(f"\n### {f.upper()}")
    print(f"  orig WIN  -> inv WIN {int((ow&iw).sum()):>6}   inv LOSS {int((ow&~iw).sum()):>6}")
    print(f"  orig LOSS -> inv WIN {int((~ow&iw).sum()):>6}   inv LOSS {int((~ow&~iw).sum()):>6}")
    losses = s[~ow]
    if len(losses):
        print(f"  of {len(losses)} original losses: {100*(losses['iNetR']>0).mean():.1f}% become inverted WINS, "
              f"{100*(losses['iNetR']<=0).mean():.1f}% remain losses")
        print(f"  inverted expectancy conditional on an original loss: {losses['iNetR'].mean():+.4f} R  "
              f"<-- NOT TRADEABLE (requires knowing the outcome first)")

print("\n" + "=" * 110)
print("LONG / SHORT ASYMMETRY")
print("=" * 110)
print(f"  {'family':<12}{'orig dir':<8}{'n':>7}{'ORIG net':>11}{'INV net':>11}{'INV 95% CI':>22}")
for f in FAMS:
    for d_ in ("long", "short"):
        s = df[(df.family == f) & (df.direction == d_)]
        if len(s) < 30: continue
        o, iv = stats(s, "oNetR"), stats(s, "iNetR")
        print(f"  {f:<12}{d_:<8}{len(s):>7}{o['exp']:>+11.4f}{iv['exp']:>+11.4f} [{iv['lo']:+.4f},{iv['hi']:+.4f}]")

print("\n" + "=" * 110)
print("PAIR BREAKDOWN")
print("=" * 110)
print(f"  {'family':<12}{'pair':<10}{'n':>7}{'ORIG net':>11}{'INV net':>11}{'INV 95% CI':>22}")
for f in FAMS:
    for p in ("EUR_USD", "GBP_USD", "USD_JPY"):
        s = df[(df.family == f) & (df.pair == p)]
        if len(s) < 30: continue
        o, iv = stats(s, "oNetR"), stats(s, "iNetR")
        print(f"  {f:<12}{p:<10}{len(s):>7}{o['exp']:>+11.4f}{iv['exp']:>+11.4f} [{iv['lo']:+.4f},{iv['hi']:+.4f}]")

print("\n" + "=" * 110)
print("FIXED-HORIZON DIRECTION TEST (no stops/targets; pure forward return)")
print("=" * 110)
print(f"  {'family':<12}{'h':>4}{'ORIG gross':>12}{'INV gross':>12}{'ORIG net':>11}{'INV net':>11}{'INV net 95% CI':>22}")
for f in FAMS:
    s = df[df.family == f]
    for h in (1, 3, 6, 12, 24):
        r = stats(s, f"iNet{h}")
        print(f"  {f:<12}{h:>4}{s[f'oGross{h}'].mean():>+12.4f}{s[f'iGross{h}'].mean():>+12.4f}"
              f"{s[f'oNet{h}'].mean():>+11.4f}{s[f'iNet{h}'].mean():>+11.4f} [{r['lo']:+.4f},{r['hi']:+.4f}]")

print("\n" + "=" * 110)
print("SESSION / REGIME / TIME STABILITY")
print("=" * 110)
print(f"  {'cut':<34}{'n':>7}{'ORIG net':>11}{'INV net':>11}")
for s_ in sorted(df.session.unique()):
    s = df[df.session == s_]
    if len(s) < 50: continue
    print(f"  session {s_:<26}{len(s):>7}{s['oNetR'].mean():>+11.4f}{s['iNetR'].mean():>+11.4f}")
for r_ in sorted(df.regime.unique()):
    s = df[df.regime == r_]
    if len(s) < 50: continue
    print(f"  regime {r_:<27}{len(s):>7}{s['oNetR'].mean():>+11.4f}{s['iNetR'].mean():>+11.4f}")
df["q"] = df["ts"].dt.to_period("Q").astype(str)
for q_ in sorted(df.q.unique()):
    s = df[df.q == q_]
    if len(s) < 50: continue
    print(f"  quarter {q_:<26}{len(s):>7}{s['oNetR'].mean():>+11.4f}{s['iNetR'].mean():>+11.4f}")

print("\n" + "=" * 110)
print("ROLLING STABILITY — 250-signal rolling inverted expectancy, all families")
print("=" * 110)
roll = df["iNetR"].rolling(250).mean().dropna()
print(f"  windows={len(roll)}  share of windows with inverted net > 0: {100*(roll>0).mean():.1f}%")
print(f"  min={roll.min():+.4f}  median={roll.median():+.4f}  max={roll.max():+.4f}")

print("\n" + "=" * 110)
print("DEV GATE — any family with inverted net > 0 and adequate effective n?")
print("=" * 110)
qual = [(f, iv) for f, (o, iv) in head.items() if iv["exp"] > 0 and iv["eff"] >= 200]
if not qual:
    print("  NONE. No family has positive inverted net expectancy.")
else:
    for f, iv in qual:
        print(f"  {f}: inv net={iv['exp']:+.4f} eff={iv['eff']} CI=[{iv['lo']:+.4f},{iv['hi']:+.4f}] "
              f"CI>0:{'YES' if iv['lo']>0 else 'no'}")
