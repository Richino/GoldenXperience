"""
TradingView economic-calendar client (stdlib only).

Why this source: Forex Factory's own exports were tested and rejected — the
faireconomy weekly feed carries NO `actual` field and only the current week
exists (lastweek/nextweek/lastmonth all 404), and forexfactory.com itself is
Cloudflare-walled (403). TradingView's public economic-calendar endpoint is
free, keyless, not Cloudflare-gated, and returns full history WITH numeric
actual/forecast/previous (`actualRaw` / `forecastRaw` / `previousRaw`).

No values are fabricated: an event with a null `actualRaw` or `forecastRaw` is
dropped, never imputed.
"""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

BASE = "https://economic-calendar.tradingview.com/events"
HEADERS = {
    "Origin": "https://www.tradingview.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _get(url: str, retries: int = 4) -> dict:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"TradingView request failed after retries: {last}\n{url}")


def fetch_window(start: datetime, end: datetime, countries: str = "US") -> list[dict]:
    """All calendar events in [start, end) for the given countries."""
    url = f"{BASE}?from={_iso(start)}&to={_iso(end)}&countries={countries}"
    data = _get(url)
    return data.get("result", []) or []


def fetch_range(
    start: datetime,
    end: datetime,
    countries: str = "US",
    chunk_days: int = 30,
    log=lambda m: None,
) -> list[dict]:
    """
    Walk [start, end] in monthly chunks (the endpoint caps how much it returns
    per call), de-duplicating by event id. Returns raw TradingView event dicts.
    """
    by_id: dict[str, dict] = {}
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + timedelta(days=chunk_days), end)
        events = fetch_window(cursor, chunk_end, countries)
        for e in events:
            eid = e.get("id")
            if eid:
                by_id[str(eid)] = e
        log(f"  {cursor.date()} -> {chunk_end.date()}: {len(events)} events "
            f"(unique total {len(by_id)})")
        cursor = chunk_end
        time.sleep(0.4)  # be gentle
    return list(by_id.values())


def is_high_impact(e: dict) -> bool:
    # TradingView importance: 1 = high, 0 = medium, -1 = low.
    return e.get("importance", -99) is not None and e.get("importance", -99) >= 1


def has_actual_and_forecast(e: dict) -> bool:
    return e.get("actualRaw") is not None and e.get("forecastRaw") is not None
