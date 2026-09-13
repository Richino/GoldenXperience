"""
Stage 4 — model, leakage-safe walk-forward backtest, baselines, verdict.

Design choices that keep the test honest:
  * The verdict rests on a WALK-FORWARD over the historical period (each event is
    predicted only from a model trained on strictly-earlier events), NOT on the
    final 10 days. The final 10 days are a separate, untouched demonstration.
  * The model is deliberately simple (multinomial logistic regression on a small
    feature set + indicator one-hot) — "start simple" to avoid overfitting ~1k
    rows.
  * Direction = event polarity * predicted surprise sign. MATCH / ambiguous
    polarity => SKIP.
  * Execution uses OANDA BID/ASK: buy at ask, sell at bid, exit on the opposite
    side, so realistic spread is always paid. SL/TP assume stop-touched-first
    within a minute (conservative).
  * The primary entry/exit rule is chosen on the HISTORICAL walk-forward only,
    then applied to the final 10 days (no OOS leakage into the choice).
"""
from __future__ import annotations

import csv
import json
import math
import os
from collections import defaultdict, Counter
from datetime import datetime, timedelta, timezone

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from lib_prices import load_prices, candle_at, candle_after, PIP

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

ENTRY_OFFSETS = [10, 5, 1]                     # minutes before release
EXIT_HORIZONS = [5, 15, 30, 60]                # minutes after release
SLTP = {"1:1": 1.0, "1:1.5": 1.5, "1:2": 2.0}  # reward:risk multiples
CONF_THRESHOLD = 0.45                          # max class prob to trade
OOS_DAYS = 10

NUM_FEATURES = [
    "forecast", "previous", "forecast_minus_previous", "forecast_vs_previous_norm",
    "beat_rate_prior", "mean_norm_surprise_prior", "prev_norm_surprise",
    "last_surprise_sign", "last3_beats", "n_prior", "recent_currency_surprise",
    "pre_trend_pips", "pre_vol_pips", "pre_range_pips", "spread_at_predict_pips",
    "us2y_trend", "us10y_trend", "have_market", "hour", "dow",
    "session_ny", "session_london",
]


# --------------------------------------------------------------------------- #
# data loading + feature matrix
# --------------------------------------------------------------------------- #
def load_rows():
    with open(os.path.join(DATA, "dataset.json")) as f:
        ds = json.load(f)
    rows = ds["rows"]
    for r in rows:
        r["_dt"] = datetime.fromisoformat(r["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
    rows.sort(key=lambda r: r["_dt"])
    return rows, ds


def build_matrix(rows, indicators):
    ind_index = {name: i for i, name in enumerate(indicators)}
    X = np.zeros((len(rows), len(NUM_FEATURES) + len(indicators)))
    for i, r in enumerate(rows):
        f = r["features"]
        for j, k in enumerate(NUM_FEATURES):
            X[i, j] = float(f.get(k, 0.0))
        ind = r["indicator"]
        if ind in ind_index:
            X[i, len(NUM_FEATURES) + ind_index[ind]] = 1.0
    return X


LABELS = ["BEAT", "MATCH", "MISS"]


def fit_predict(train_rows, test_rows, indicators):
    Xtr = build_matrix(train_rows, indicators)
    Xte = build_matrix(test_rows, indicators)
    ytr = np.array([r["target"]["label"] for r in train_rows])
    if len(set(ytr)) < 2:
        # degenerate; predict priors
        return [{"BEAT": 0.34, "MATCH": 0.33, "MISS": 0.33} for _ in test_rows]
    scaler = StandardScaler().fit(Xtr)
    clf = LogisticRegression(max_iter=2000, C=0.5, class_weight="balanced")
    clf.fit(scaler.transform(Xtr), ytr)
    proba = clf.predict_proba(scaler.transform(Xte))
    classes = list(clf.classes_)
    out = []
    for p in proba:
        d = {c: 0.0 for c in LABELS}
        for c, val in zip(classes, p):
            d[c] = float(val)
        out.append(d)
    return out


# --------------------------------------------------------------------------- #
# execution
# --------------------------------------------------------------------------- #
def risk_pips_for(row):
    pr = row["features"].get("pre_range_pips", 0.0)
    if not row["features"].get("have_market"):
        return 15.0
    return float(min(30.0, max(10.0, round(pr * 0.6))))


def simulate(row, side, entry_off, risk_pips, use_mid=False):
    """
    side: +1 buy EUR_USD (long), -1 sell (short). Returns None if no prices.
    use_mid=True executes at MID (zero spread) — the gross/no-cost counterfactual
    used to isolate how much of the result is spread vs direction.
    """
    prices = load_prices(row["id"])
    if not prices or not prices.get("eurusd"):
        return None
    ba = prices["eurusd"]
    event_dt = row["_dt"]
    entry_dt = event_dt - timedelta(minutes=entry_off)
    ec = candle_at(ba, entry_dt)
    if not ec:
        return None
    if use_mid:
        entry = (ec["ao"] + ec["bo"]) / 2
    elif side > 0:
        entry = ec["ao"]      # buy at ask
    else:
        entry = ec["bo"]      # sell at bid
    spread = (ec["ac"] - ec["bc"]) / PIP

    def pips_at(exit_price):
        return ((exit_price - entry) if side > 0 else (entry - exit_price)) / PIP

    outcomes = {}
    # fixed-time exits
    for h in EXIT_HORIZONS:
        xc = candle_after(ba, event_dt + timedelta(minutes=h))
        if not xc:
            outcomes[f"T{h}"] = None
            continue
        if use_mid:
            exit_price = (xc["bc"] + xc["ac"]) / 2
        else:
            exit_price = xc["bc"] if side > 0 else xc["ac"]  # close opposite side
        p = pips_at(exit_price)
        outcomes[f"T{h}"] = {"exit_price": exit_price, "pips": p, "R": p / risk_pips,
                             "win": 1 if p > 0 else 0}
    # SL/TP exits (walk minute candles after release)
    fwd = [c for c in ba if datetime.fromisoformat(c["t"]).replace(tzinfo=timezone.utc) > event_dt]
    for name, rr in SLTP.items():
        stop = risk_pips
        tp = risk_pips * rr
        res = None
        for c in fwd:
            if use_mid:
                hi_side = ((c["bh"] + c["ah"]) / 2 - entry) / PIP if side > 0 else (entry - (c["bl"] + c["al"]) / 2) / PIP
                lo_side = ((c["bl"] + c["al"]) / 2 - entry) / PIP if side > 0 else (entry - (c["bh"] + c["ah"]) / 2) / PIP
                hit_stop = lo_side <= -stop
                hit_tp = hi_side >= tp
            elif side > 0:
                lo = (c["bl"] - entry) / PIP
                hi = (c["bh"] - entry) / PIP
                hit_stop = lo <= -stop
                hit_tp = hi >= tp
            else:
                hi = (entry - c["ah"]) / PIP
                lo = (entry - c["al"]) / PIP
                hit_stop = hi <= -stop  # adverse move up in ask
                hit_tp = lo >= tp
            if hit_stop:  # conservative: stop first
                res = {"pips": -stop, "R": -1.0, "win": 0, "exit_price": None}
                break
            if hit_tp:
                res = {"pips": tp, "R": rr, "win": 1, "exit_price": None}
                break
        if res is None:  # no touch in +95m window -> close at last candle
            last = fwd[-1] if fwd else None
            if last:
                if use_mid:
                    exit_price = (last["bc"] + last["ac"]) / 2
                else:
                    exit_price = last["bc"] if side > 0 else last["ac"]
                p = pips_at(exit_price)
                res = {"pips": p, "R": p / risk_pips, "win": 1 if p > 0 else 0, "exit_price": exit_price}
        outcomes[f"SLTP {name}"] = res

    return {"entry": entry, "spread": spread, "risk_pips": risk_pips, "outcomes": outcomes}


# --------------------------------------------------------------------------- #
# prediction -> trade decision
# --------------------------------------------------------------------------- #
def decide(row, proba, threshold):
    """Return (predicted_label, confidence, surprise_dir, currency_dir, side) or None to SKIP."""
    if not row["tradeable"]:
        return None
    pol = row["polarity"]
    pbeat, pmiss = proba["BEAT"], proba["MISS"]
    top = max(proba, key=proba.get)
    conf = proba[top]
    if top == "MATCH":
        return None
    if conf < threshold:
        return None
    surprise_dir = 1 if pbeat >= pmiss else -1
    currency_dir = pol * surprise_dir           # +1 USD bullish, -1 USD bearish
    # EUR_USD: USD bullish -> SELL; USD bearish -> BUY
    side = -1 if currency_dir > 0 else 1
    return {"label": top, "confidence": conf, "surprise_dir": surprise_dir,
            "currency_dir": currency_dir, "side": side}


def baseline_dir(kind, row):
    """Return currency_dir (+1 USD bull / -1 bear) or 0 skip for baselines A/B/C."""
    pol = row["polarity"]
    f = row["features"]
    if not row["tradeable"]:
        return 0
    if kind == "A":   # actual follows previous: surprise sign ~ sign(previous - forecast)
        s = np.sign(f["previous"] - f["forecast"])
        return int(pol * s)
    if kind == "B":   # forecast vs previous only
        s = np.sign(f["forecast"] - f["previous"])
        return int(pol * s)
    if kind == "C":   # pre-news market trend only (USD strength = -EURUSD trend)
        return int(np.sign(-f["pre_trend_pips"]))
    return 0


# --------------------------------------------------------------------------- #
# metrics
# --------------------------------------------------------------------------- #
def agg(trades, key="R"):
    vals = [t[key] for t in trades]
    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v <= 0]
    gp = sum(t["pips"] for t in trades if t["pips"] > 0)
    gl = -sum(t["pips"] for t in trades if t["pips"] <= 0)
    n = len(trades)
    return {
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / n, 4) if n else 0.0,
        "avg_pips": round(sum(t["pips"] for t in trades) / n, 3) if n else 0.0,
        "expectancy_R": round(sum(vals) / n, 4) if n else 0.0,
        "profit_factor": round(gp / gl, 3) if gl > 0 else (float("inf") if gp > 0 else 0.0),
        "total_pips": round(sum(t["pips"] for t in trades), 1),
    }


def main():
    rows, ds = load_rows()
    indicators = sorted({r["indicator"] for r in rows})
    max_dt = max(r["_dt"] for r in rows)
    split_dt = max_dt - timedelta(days=OOS_DAYS)
    historical = [r for r in rows if r["_dt"] < split_dt]
    final10 = [r for r in rows if r["_dt"] >= split_dt]
    print(f"rows={len(rows)} historical={len(historical)} final10={len(final10)} split={split_dt.date()}")

    # ---- walk-forward over historical ----
    init_n = int(len(historical) * 0.40)
    step_days = 30
    wf_preds = {}  # id -> proba
    start_idx = init_n
    cursor_dt = historical[start_idx]["_dt"]
    while start_idx < len(historical):
        win_end = cursor_dt + timedelta(days=step_days)
        test = [r for r in historical[start_idx:] if r["_dt"] < win_end]
        if not test:
            cursor_dt = win_end
            continue
        train = [r for r in historical if r["_dt"] < test[0]["_dt"]]
        proba = fit_predict(train, test, indicators)
        for r, p in zip(test, proba):
            wf_preds[r["id"]] = p
        start_idx += len(test)
        cursor_dt = win_end
    print(f"walk-forward predictions: {len(wf_preds)}")

    # ---- final model on all historical -> final10 ----
    final_proba = fit_predict(historical, final10, indicators) if final10 else []
    final_pred = {r["id"]: p for r, p in zip(final10, final_proba)}

    # ---- helper to build trade records for a set of rows w/ a proba source ----
    def make_trades(row_subset, proba_source, entry_off, exit_rule, threshold=CONF_THRESHOLD, use_mid=False):
        out = []
        for r in row_subset:
            p = proba_source.get(r["id"])
            if p is None:
                continue
            d = decide(r, p, threshold)
            if d is None:
                continue
            risk = risk_pips_for(r)
            sim = simulate(r, d["side"], entry_off, risk, use_mid=use_mid)
            if not sim:
                continue
            oc = sim["outcomes"].get(exit_rule)
            if oc is None:
                continue
            out.append({
                "id": r["id"], "date": r["date"], "indicator": r["indicator"],
                "forecast": r["features"]["forecast"], "previous": r["features"]["previous"],
                "label": d["label"], "confidence": round(d["confidence"], 3),
                "currency_dir": d["currency_dir"], "side": d["side"],
                "entry_off": entry_off, "entry": sim["entry"], "spread": round(sim["spread"], 2),
                "exit_rule": exit_rule, "exit_price": oc.get("exit_price"),
                "pips": round(oc["pips"], 2), "R": round(oc["R"], 3), "win": oc["win"],
                "risk_pips": risk,
            })
        return out

    # ---- choose primary entry/exit on HISTORICAL walk-forward only ----
    grid = {}
    for eo in ENTRY_OFFSETS:
        for xr in [f"T{h}" for h in EXIT_HORIZONS] + [f"SLTP {k}" for k in SLTP]:
            t = make_trades(historical, wf_preds, eo, xr)
            grid[(eo, xr)] = agg(t)
    # pick by expectancy_R with a minimum trade count
    eligible = {k: v for k, v in grid.items() if v["trades"] >= 30}
    primary = max(eligible or grid, key=lambda k: (eligible or grid)[k]["expectancy_R"])
    primary_eo, primary_xr = primary
    print(f"primary entry/exit chosen on historical WF: entry -{primary_eo}m, exit {primary_xr}")

    # ---- model results on historical WF (verdict basis) at primary config ----
    hist_trades = make_trades(historical, wf_preds, primary_eo, primary_xr)
    hist_metrics = agg(hist_trades)

    # ---- GROSS (mid, zero-spread) counterfactual: is spread the killer? ----
    gross_primary = agg(make_trades(historical, wf_preds, primary_eo, primary_xr, use_mid=True))
    spread_decomp = {
        "net_expectancy_R": hist_metrics["expectancy_R"],
        "gross_expectancy_R": gross_primary["expectancy_R"],
        "spread_drag_R": round(gross_primary["expectancy_R"] - hist_metrics["expectancy_R"], 4),
        "net_avg_pips": hist_metrics["avg_pips"],
        "gross_avg_pips": gross_primary["avg_pips"],
        "by_exit": {
            xr: {
                "net": agg(make_trades(historical, wf_preds, primary_eo, xr))["expectancy_R"],
                "gross": agg(make_trades(historical, wf_preds, primary_eo, xr, use_mid=True))["expectancy_R"],
            }
            for xr in [f"T{h}" for h in EXIT_HORIZONS] + [f"SLTP {k}" for k in SLTP]
        },
    }

    # ---- baselines on historical, all tradeable, single entry -5m / exit T30 ----
    def baseline_trades(kind):
        out = []
        for r in historical:
            cd = baseline_dir(kind, r)
            if cd == 0:
                continue
            side = -1 if cd > 0 else 1
            risk = risk_pips_for(r)
            sim = simulate(r, side, 5, risk)
            if not sim:
                continue
            oc = sim["outcomes"].get("T30")
            if oc is None:
                continue
            out.append({"pips": oc["pips"], "R": oc["R"], "win": oc["win"]})
        return out

    baselines = {}
    for kind, name in [("A", "A_actual_follows_previous"), ("B", "B_forecast_vs_previous"),
                       ("C", "C_prenews_trend_only")]:
        baselines[name] = agg(baseline_trades(kind))
    # D: model on same universe (all tradeable, threshold 0) entry -5m exit T30
    d_trades = make_trades(historical, wf_preds, 5, "T30", threshold=0.0)
    baselines["D_full_model"] = agg(d_trades)

    # ---- results by bucket (historical WF, primary config) ----
    def bucket(trades, keyfn):
        b = defaultdict(list)
        for t in trades:
            b[keyfn(t)].append(t)
        return {str(k): agg(v) for k, v in sorted(b.items())}

    by_event = bucket(hist_trades, lambda t: t["indicator"])
    conf_bucket = bucket(hist_trades, lambda t: (
        "0.45-0.55" if t["confidence"] < 0.55 else "0.55-0.65" if t["confidence"] < 0.65 else "0.65+"))
    by_entry = {f"-{eo}m": agg(make_trades(historical, wf_preds, eo, primary_xr)) for eo in ENTRY_OFFSETS}
    by_exit = {xr: agg(make_trades(historical, wf_preds, primary_eo, xr))
               for xr in [f"T{h}" for h in EXIT_HORIZONS] + [f"SLTP {k}" for k in SLTP]}

    # ---- final 10-day OOS trades (all entry offsets, primary exit) ----
    final_trades_all = []
    for eo in ENTRY_OFFSETS:
        final_trades_all += make_trades(final10, final_pred, eo, primary_xr)
    final_primary = make_trades(final10, final_pred, primary_eo, primary_xr)
    final_metrics = agg(final_primary)

    # ---- verdict ----
    best_baseline = max(
        [baselines["A_actual_follows_previous"], baselines["B_forecast_vs_previous"],
         baselines["C_prenews_trend_only"]],
        key=lambda m: m["expectancy_R"])
    # "Beats baselines" must mean profitable AND ahead of the naive rules — being
    # merely less-negative than a losing baseline is not an edge.
    beats_baselines = (
        hist_metrics["expectancy_R"] > 0
        and hist_metrics["expectancy_R"] > best_baseline["expectancy_R"]
        and hist_metrics["expectancy_R"] > baselines["D_full_model"]["expectancy_R"]
    )
    n_hist = hist_metrics["trades"]

    if n_hist < 60:
        verdict = "INSUFFICIENT_DATA"
    elif hist_metrics["expectancy_R"] <= 0 or hist_metrics["profit_factor"] <= 1.0:
        verdict = "NO_PRE_NEWS_EDGE"
    elif beats_baselines and hist_metrics["profit_factor"] >= 1.2 and hist_metrics["win_rate"] >= 0.5:
        verdict = "PROMISING_BUT_UNPROVEN"
    else:
        verdict = "NO_PRE_NEWS_EDGE"
    # PRE_NEWS_EDGE is intentionally hard to reach on ~1 model / ~1k rows and is
    # reserved for a clearly robust, baseline-beating, positive-PF result.
    if (verdict == "PROMISING_BUT_UNPROVEN" and hist_metrics["profit_factor"] >= 1.5
            and hist_metrics["expectancy_R"] >= 0.15 and n_hist >= 150 and beats_baselines):
        verdict = "PRE_NEWS_EDGE"

    results = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "USD high-impact, EUR_USD execution, bid/ask",
        "n_rows": len(rows), "n_historical": len(historical), "n_final10": len(final10),
        "oos_split_date": split_dt.isoformat(),
        "primary_entry_offset_min": primary_eo, "primary_exit_rule": primary_xr,
        "conf_threshold": CONF_THRESHOLD,
        "historical_walkforward": hist_metrics,
        "spread_decomposition": spread_decomp,
        "final_10day_oos": final_metrics,
        "baselines": baselines,
        "beats_baselines": bool(beats_baselines),
        "by_event": by_event,
        "by_confidence": conf_bucket,
        "by_entry_timing": by_entry,
        "by_exit_horizon": by_exit,
        "grid_expectancy_R": {f"entry-{eo}m|{xr}": grid[(eo, xr)]["expectancy_R"]
                              for (eo, xr) in grid},
        "verdict": verdict,
    }
    with open(os.path.join(DATA, "..", "RESULTS.json"), "w") as f:
        json.dump(results, f, indent=2)

    # ---- PREDICTIONS.json ----
    preds_out = []
    for r in historical:
        p = wf_preds.get(r["id"])
        if not p:
            continue
        d = decide(r, p, 0.0)
        preds_out.append({"id": r["id"], "date": r["date"], "indicator": r["indicator"],
                          "set": "historical_wf", "proba": {k: round(v, 3) for k, v in p.items()},
                          "predicted_label": max(p, key=p.get),
                          "actual_label": r["target"]["label"],
                          "polarity": r["polarity"],
                          "currency_dir": (d["currency_dir"] if d else 0)})
    for r in final10:
        p = final_pred.get(r["id"])
        if not p:
            continue
        d = decide(r, p, 0.0)
        preds_out.append({"id": r["id"], "date": r["date"], "indicator": r["indicator"],
                          "set": "final_10day_oos", "proba": {k: round(v, 3) for k, v in p.items()},
                          "predicted_label": max(p, key=p.get),
                          "actual_label": r["target"]["label"],
                          "polarity": r["polarity"],
                          "currency_dir": (d["currency_dir"] if d else 0)})
    with open(os.path.join(DATA, "..", "PREDICTIONS.json"), "w") as f:
        json.dump(preds_out, f, indent=2)

    # ---- TRADES.csv (final 10-day eligible trades, all entry offsets, primary exit) ----
    id_to_row = {r["id"]: r for r in rows}
    cols = ["Date", "Time", "Event", "Currency", "Forecast", "Previous",
            "PredictedSurpriseDir", "PredictedLabel", "Confidence", "PredictedCurrencyDir",
            "Pair", "Side", "EntryTime", "EntryPrice", "Spread", "ExitPrice", "ExitRule",
            "Pips", "R", "WinLoss"]
    with open(os.path.join(DATA, "..", "TRADES.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for t in final_trades_all:
            r = id_to_row[t["id"]]
            dt = r["_dt"]
            entry_time = (dt - timedelta(minutes=t["entry_off"])).strftime("%H:%M")
            w.writerow([
                dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M"), t["indicator"], "USD",
                t["forecast"], t["previous"],
                "BEAT" if t["label"] == "BEAT" else ("MISS" if t["label"] == "MISS" else t["label"]),
                t["label"], t["confidence"],
                "USD_BULL" if t["currency_dir"] > 0 else "USD_BEAR",
                "EUR_USD", "SELL" if t["side"] < 0 else "BUY",
                entry_time, round(t["entry"], 5), t["spread"],
                round(t["exit_price"], 5) if t["exit_price"] is not None else "",
                t["exit_rule"], t["pips"], t["R"], "WIN" if t["win"] else "LOSS",
            ])

    print("\n=== HISTORICAL WALK-FORWARD (verdict basis) @", f"entry-{primary_eo}m {primary_xr} ===")
    print(hist_metrics)
    print("baselines:", json.dumps(baselines, indent=2))
    print("final 10-day OOS:", final_metrics)
    print("VERDICT:", verdict)
    # stash for report
    with open(os.path.join(DATA, "_report_ctx.json"), "w") as f:
        json.dump({"results": results, "n_final_trades": len(final_trades_all)}, f)


if __name__ == "__main__":
    main()
