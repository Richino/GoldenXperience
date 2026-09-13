"""
Stage 3 — build the leakage-safe modelling dataset.

For every USD high-impact event (sorted by time) we compute:
  * TARGETS  (label BEAT/MATCH/MISS, surprise, normalized surprise) — derived
    from the actual value. These are ONLY ever used as training targets for
    PAST events; they are never features and the current event's actual is
    never visible at prediction time.
  * FEATURES frozen at PREDICT_TIME = event_time - 10 minutes. Everything here
    is knowable strictly before the earliest tested entry (-10m), so the -5m and
    -1m entries cannot leak either. Per-indicator tendency stats use PRIOR
    releases only (expanding), never the current or future ones.

Writes data/dataset.json.
"""
from __future__ import annotations

import json
import math
import os
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from lib_prices import load_prices, candle_at, mid_series, mid_series_m, PIP

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

PREDICT_OFFSET_MIN = 10          # features frozen here (earliest entry)
PRE_WINDOW_MIN = 60              # trend / vol / yield look-back
MATCH_BAND = 0.25                # |normalized surprise| below this = MATCH
RECENT_CURRENCY_DAYS = 14

with open(os.path.join(HERE, "EVENT_POLARITY.json")) as f:
    POLARITY = {k: v["p"] for k, v in json.load(f)["polarity"].items()}


def indicator_of(e: dict) -> str:
    return e.get("indicator") or e.get("title") or "?"


def stdev(xs: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    m = sum(xs) / n
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))


def main() -> None:
    with open(os.path.join(DATA, "calendar_usd_high.json")) as f:
        events = json.load(f)
    for e in events:
        e["_dt"] = datetime.fromisoformat(e["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
    events.sort(key=lambda e: e["_dt"])

    # Expanding per-indicator history of raw surprises (prior only).
    hist_surprise: dict[str, list[float]] = defaultdict(list)
    # Rolling recent USD surprises for the momentum feature (prior only).
    recent_norm: deque[tuple[datetime, float]] = deque()

    rows = []
    skipped_no_prices = 0

    for e in events:
        ind = indicator_of(e)
        actual = e.get("actualRaw")
        forecast = e.get("forecastRaw")
        previous = e.get("previousRaw")
        if actual is None or forecast is None:
            continue

        dt = e["_dt"]
        predict_time = dt - timedelta(minutes=PREDICT_OFFSET_MIN)

        # ---- causal per-indicator scale from PRIOR surprises only ----
        prior = hist_surprise[ind]
        scale = stdev(prior) if len(prior) >= 4 else None
        # fallback scale: magnitude of forecast, else 1
        if not scale or scale == 0:
            scale = abs(forecast) * 0.05 or abs(previous or 0) * 0.05 or 1.0

        surprise = actual - forecast
        norm_surprise = surprise / scale

        # ---- label (target) ----
        if abs(norm_surprise) < MATCH_BAND:
            label = "MATCH"
        elif norm_surprise > 0:
            label = "BEAT"
        else:
            label = "MISS"

        # ---- tendency features from PRIOR releases of this indicator ----
        prior_beats = [1 if s > 0 else 0 for s in prior]
        beat_rate_prior = sum(prior_beats) / len(prior_beats) if prior_beats else 0.5
        prior_norm = [s / scale for s in prior]
        mean_norm_prior = sum(prior_norm) / len(prior_norm) if prior_norm else 0.0
        last_surprise_sign = (1 if prior[-1] > 0 else -1) if prior else 0
        last3 = prior[-3:]
        last3_beats = sum(1 for s in last3 if s > 0)
        prev_norm_surprise = (prior[-1] / scale) if prior else 0.0
        n_prior = len(prior)

        # ---- recent same-currency surprise momentum (prior 14d) ----
        cutoff = predict_time - timedelta(days=RECENT_CURRENCY_DAYS)
        while recent_norm and recent_norm[0][0] < cutoff:
            recent_norm.popleft()
        recent_vals = [v for (t, v) in recent_norm if t <= predict_time]
        recent_currency_surprise = sum(recent_vals) / len(recent_vals) if recent_vals else 0.0

        # ---- forecast vs previous ----
        fvp = (forecast - previous) if previous is not None else 0.0
        fvp_norm = fvp / scale

        # ---- market features from cached prices, up to predict_time ----
        prices = load_prices(str(e["id"]))
        mkt = {
            "pre_trend_pips": 0.0, "pre_vol_pips": 0.0, "pre_range_pips": 0.0,
            "spread_at_entry_pips": None, "us2y_trend": 0.0, "us10y_trend": 0.0,
            "have_market": 0,
        }
        if prices and prices.get("eurusd"):
            ba = prices["eurusd"]
            start = predict_time - timedelta(minutes=PRE_WINDOW_MIN)
            series = mid_series(ba, start, predict_time)
            if len(series) >= 5:
                mids = [m for (_, m) in series]
                rets = [(mids[i] - mids[i - 1]) / PIP for i in range(1, len(mids))]
                mkt["pre_trend_pips"] = (mids[-1] - mids[0]) / PIP
                mkt["pre_vol_pips"] = stdev(rets)
                mkt["pre_range_pips"] = (max(mids) - min(mids)) / PIP
                mkt["have_market"] = 1
            entry_c = candle_at(ba, predict_time)
            if entry_c:
                mkt["spread_at_entry_pips"] = (entry_c["ac"] - entry_c["bc"]) / PIP
            for key, arr in (("us2y_trend", prices.get("us2y")), ("us10y_trend", prices.get("us10y"))):
                if arr:
                    ys = mid_series_m(arr, start, predict_time)
                    if len(ys) >= 2:
                        mkt[key] = ys[-1][1] - ys[0][1]
        else:
            skipped_no_prices += 1

        # ---- session / time ----
        hour = dt.hour
        dow = dt.weekday()
        session = "ny" if 13 <= hour < 21 else ("london" if 7 <= hour < 13 else "off")

        rows.append({
            "id": str(e["id"]),
            "date": e["date"],
            "indicator": ind,
            "period": e.get("period"),
            "forecast": forecast,
            "previous": previous,
            # target block (NOT features)
            "target": {
                "actual": actual,
                "surprise": surprise,
                "norm_surprise": norm_surprise,
                "label": label,
            },
            "polarity": POLARITY.get(ind, 0),
            "tradeable": 1 if POLARITY.get(ind, 0) != 0 else 0,
            "features": {
                "forecast": forecast,
                "previous": previous if previous is not None else forecast,
                "forecast_minus_previous": fvp,
                "forecast_vs_previous_norm": fvp_norm,
                "beat_rate_prior": beat_rate_prior,
                "mean_norm_surprise_prior": mean_norm_prior,
                "prev_norm_surprise": prev_norm_surprise,
                "last_surprise_sign": last_surprise_sign,
                "last3_beats": last3_beats,
                "n_prior": n_prior,
                "recent_currency_surprise": recent_currency_surprise,
                "pre_trend_pips": mkt["pre_trend_pips"],
                "pre_vol_pips": mkt["pre_vol_pips"],
                "pre_range_pips": mkt["pre_range_pips"],
                "spread_at_predict_pips": mkt["spread_at_entry_pips"] if mkt["spread_at_entry_pips"] is not None else 2.0,
                "us2y_trend": mkt["us2y_trend"],
                "us10y_trend": mkt["us10y_trend"],
                "have_market": mkt["have_market"],
                "hour": hour,
                "dow": dow,
                "session_ny": 1 if session == "ny" else 0,
                "session_london": 1 if session == "london" else 0,
            },
        })

        # advance causal histories AFTER using them
        hist_surprise[ind].append(surprise)
        recent_norm.append((dt, norm_surprise))

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "tradingview_economic_calendar + oanda_bidask",
        "scope": "USD high-impact",
        "predict_offset_min": PREDICT_OFFSET_MIN,
        "match_band_norm": MATCH_BAND,
        "n": len(rows),
        "rows": rows,
    }
    with open(os.path.join(DATA, "dataset.json"), "w") as f:
        json.dump(out, f)

    # summary
    from collections import Counter
    labels = Counter(r["target"]["label"] for r in rows)
    tradeable = sum(r["tradeable"] for r in rows)
    have_mkt = sum(r["features"]["have_market"] for r in rows)
    print(f"rows={len(rows)}  labels={dict(labels)}")
    print(f"tradeable(polarity!=0)={tradeable}  have_market={have_mkt}  no_price_cache={skipped_no_prices}")
    print(f"span {rows[0]['date']} -> {rows[-1]['date']}")


if __name__ == "__main__":
    main()
