"""
Stage 1 — fetch the USD high-impact economic calendar with history.

Writes data/calendar_raw.json (everything TradingView returned) and
data/calendar_usd_high.json (USD, importance>=high, with numeric actual AND
forecast present). Nothing is imputed.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from lib_tv import fetch_range, is_high_impact, has_actual_and_forecast

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
os.makedirs(DATA, exist_ok=True)

# ~5 years of history; more is better for per-event tendency features.
START = datetime(2021, 1, 1, tzinfo=timezone.utc)
END = datetime.now(timezone.utc)


def main() -> None:
    print(f"Fetching US calendar {START.date()} -> {END.date()} ...")
    raw = fetch_range(START, END, countries="US", log=print)
    with open(os.path.join(DATA, "calendar_raw.json"), "w") as f:
        json.dump(raw, f)
    print(f"Raw US events: {len(raw)}")

    usd_high = [
        e
        for e in raw
        if (e.get("currency") == "USD" or e.get("country") == "US")
        and is_high_impact(e)
        and has_actual_and_forecast(e)
    ]
    usd_high.sort(key=lambda e: e.get("date", ""))

    with open(os.path.join(DATA, "calendar_usd_high.json"), "w") as f:
        json.dump(usd_high, f, indent=2)

    # Quick coverage summary by indicator so we know what the polarity map needs.
    from collections import Counter

    by_ind = Counter(e.get("indicator") or e.get("title") for e in usd_high)
    print(f"\nUSD high-impact w/ actual+forecast: {len(usd_high)}")
    print(f"Distinct indicators: {len(by_ind)}")
    print("Top indicators:")
    for name, n in by_ind.most_common(30):
        print(f"  {n:4d}  {name}")
    if usd_high:
        print(f"\nDate span: {usd_high[0]['date']}  ->  {usd_high[-1]['date']}")


if __name__ == "__main__":
    main()
