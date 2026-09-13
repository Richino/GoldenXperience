"""
Stage 6 — drill into ONE indicator (default: Producer Price Inflation MoM).

Answers: is its edge gross-positive, spread-tolerant, robust across entry/exit
choices and across years, or is it small-sample / outlier-driven noise?

Reuses the walk-forward probabilities already written to PREDICTIONS.json and
the simulate/decide logic from stage 4 (imported by string because the module
name starts with a digit).
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
m = importlib.import_module("04_model_backtest")

INDICATOR = sys.argv[1] if len(sys.argv) > 1 else "Producer Price Inflation MoM"


def load():
    ds = json.load(open(os.path.join(HERE, "data", "dataset.json")))
    rows = {r["id"]: r for r in ds["rows"]}
    for r in rows.values():
        r["_dt"] = datetime.fromisoformat(r["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
    preds = json.load(open(os.path.join(HERE, "PREDICTIONS.json")))
    proba = {p["id"]: p["proba"] for p in preds}
    sets = {p["id"]: p["set"] for p in preds}
    return rows, proba, sets


def trades_for(rows, proba, ids, entry_off, exit_rule, threshold, use_mid=False):
    out = []
    for eid in ids:
        r = rows[eid]
        p = proba.get(eid)
        if not p:
            continue
        d = m.decide(r, p, threshold)
        if d is None:
            continue
        risk = m.risk_pips_for(r)
        sim = m.simulate(r, d["side"], entry_off, risk, use_mid=use_mid)
        if not sim:
            continue
        oc = sim["outcomes"].get(exit_rule)
        if oc is None:
            continue
        out.append({"id": eid, "date": r["date"], "year": r["_dt"].year,
                    "side": d["side"], "conf": round(d["confidence"], 3),
                    "spread": round(sim["spread"], 2),
                    "pips": round(oc["pips"], 2), "R": round(oc["R"], 3), "win": oc["win"]})
    return out


def main():
    rows, proba, sets = load()
    ids = [eid for eid, r in rows.items() if r["indicator"] == INDICATOR and eid in proba]
    ids.sort(key=lambda i: rows[i]["_dt"])
    print(f"=== {INDICATOR} ===")
    print(f"events with a walk-forward/OOS prediction: {len(ids)}")

    # threshold 0 => every predicted-direction trade (max sample); also show the
    # deployed threshold.
    for thr, lab in [(0.0, "all (thr=0)"), (m.CONF_THRESHOLD, f"thr={m.CONF_THRESHOLD}")]:
        print(f"\n--- {lab} : NET vs GROSS grid (expectancy_R [n]) ---")
        print(f"{'exit':12}", "".join(f"{'-'+str(eo)+'m':>18}" for eo in m.ENTRY_OFFSETS))
        for xr in [f"T{h}" for h in m.EXIT_HORIZONS] + [f"SLTP {k}" for k in m.SLTP]:
            cells = []
            for eo in m.ENTRY_OFFSETS:
                net = m.agg(trades_for(rows, proba, ids, eo, xr, thr))
                gro = m.agg(trades_for(rows, proba, ids, eo, xr, thr, use_mid=True))
                cells.append(f"{net['expectancy_R']:+.2f}/{gro['expectancy_R']:+.2f}[{net['trades']}]")
            print(f"{xr:12}", "".join(f"{c:>18}" for c in cells))

    # primary config detail: blotter, yearly, outlier dependence
    eo, xr = 5, "SLTP 1:2"
    tr = trades_for(rows, proba, ids, eo, xr, 0.0)
    trg = trades_for(rows, proba, ids, eo, xr, 0.0, use_mid=True)
    net, gross = m.agg(tr), m.agg(trg)
    print(f"\n--- primary detail: entry -{eo}m, {xr}, thr=0 ---")
    print("NET  :", net)
    print("GROSS:", gross)
    print(f"avg spread: {sum(t['spread'] for t in tr)/len(tr):.2f} pips" if tr else "no trades")

    # yearly
    print("\nby year (NET):")
    for y in sorted({t['year'] for t in tr}):
        yt = [t for t in tr if t['year'] == y]
        a = m.agg(yt)
        print(f"  {y}: n={a['trades']} exp={a['expectancy_R']:+.3f} pf={a['profit_factor']} wr={a['win_rate']}")

    # outlier dependence: remove best trade
    if len(tr) >= 3:
        srt = sorted(tr, key=lambda t: t['R'])
        without_best = m.agg(srt[:-1])
        without_best2 = m.agg(srt[:-2])
        print(f"\noutlier check (NET expectancy): all={net['expectancy_R']:+.3f}  "
              f"drop-top1={without_best['expectancy_R']:+.3f}  drop-top2={without_best2['expectancy_R']:+.3f}")
        print("R distribution:", [t['R'] for t in srt])

    # blotter
    print("\nblotter (date, side, conf, spread, pips, R, W/L):")
    for t in tr:
        print(f"  {t['date'][:10]}  {'SELL' if t['side']<0 else 'BUY ':4}  c={t['conf']}  "
              f"sp={t['spread']}  {t['pips']:+6.1f}p  {t['R']:+.2f}R  {'W' if t['win'] else 'L'}")


if __name__ == "__main__":
    main()
