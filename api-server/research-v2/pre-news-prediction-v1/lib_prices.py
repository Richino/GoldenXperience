"""
Shared price helpers over the cached OANDA windows (stage 2 output).

Every function is time-explicit so the dataset builder and the backtester agree
on exactly which candle represents a given instant, and so nothing after the
prediction/entry instant can leak into a feature.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "prices")
PIP = 0.0001  # EUR_USD


def load_prices(event_id: str) -> dict | None:
    path = os.path.join(CACHE, f"{event_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def _ts(candle_time: str) -> datetime:
    # cached times are 'YYYY-MM-DDTHH:MM:SS'
    return datetime.fromisoformat(candle_time).replace(tzinfo=timezone.utc)


def candle_at(candles: list[dict], when: datetime, tol_sec: int = 90):
    """The candle whose minute contains/precedes `when`, within tolerance."""
    best = None
    best_dt = None
    for c in candles:
        ct = _ts(c["t"])
        if ct <= when:
            if best_dt is None or ct > best_dt:
                best, best_dt = c, ct
    if best is None:
        return None
    if (when - best_dt).total_seconds() > tol_sec + 60:
        return None
    return best


def candle_after(candles: list[dict], when: datetime, tol_sec: int = 120):
    best = None
    best_dt = None
    for c in candles:
        ct = _ts(c["t"])
        if ct >= when:
            if best_dt is None or ct < best_dt:
                best, best_dt = c, ct
    if best is None:
        return None
    if (best_dt - when).total_seconds() > tol_sec + 60:
        return None
    return best


def mid_series(candles_ba: list[dict], start: datetime, end: datetime) -> list[tuple[datetime, float]]:
    out = []
    for c in candles_ba:
        ct = _ts(c["t"])
        if start <= ct <= end:
            out.append((ct, (c["bc"] + c["ac"]) / 2.0))
    return out


def mid_series_m(candles_m: list[dict], start: datetime, end: datetime) -> list[tuple[datetime, float]]:
    out = []
    for c in candles_m:
        ct = _ts(c["t"])
        if start <= ct <= end:
            out.append((ct, c["c"]))
    return out
