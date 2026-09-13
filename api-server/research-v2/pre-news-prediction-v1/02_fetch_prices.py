"""
Stage 2 — cache OANDA prices around every USD high-impact event.

For each event at time T we cache one window [-95m, +95m]:
  - EUR_USD  M1 BID/ASK  (execution + pre-news trend/vol/spread)
  - USB02Y_USD / USB10Y_USD  M1 MID  (pre-news yield features)

The window spans the earliest entry (-10m) and latest exit (+60m) plus a 60m
pre-window for trend/volatility, with buffer. Resumable: existing per-event
cache files are skipped.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

from lib_oanda import fetch_candles

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "prices")
os.makedirs(CACHE, exist_ok=True)

PRE_MIN = 95
POST_MIN = 95


def _compact_ba(candles: list[dict]) -> list[dict]:
    out = []
    for c in candles:
        b, a = c.get("bid"), c.get("ask")
        if not b or not a:
            continue
        out.append(
            {
                "t": c["time"][:19],
                "bo": float(b["o"]), "bh": float(b["h"]), "bl": float(b["l"]), "bc": float(b["c"]),
                "ao": float(a["o"]), "ah": float(a["h"]), "al": float(a["l"]), "ac": float(a["c"]),
                "v": c.get("volume", 0),
            }
        )
    return out


def _compact_mid(candles: list[dict]) -> list[dict]:
    out = []
    for c in candles:
        m = c.get("mid")
        if not m:
            continue
        out.append({"t": c["time"][:19], "c": float(m["c"])})
    return out


def main() -> None:
    with open(os.path.join(DATA, "calendar_usd_high.json")) as f:
        events = json.load(f)

    print(f"Caching prices for {len(events)} events into {CACHE}")
    done = skipped = empty = 0
    for i, e in enumerate(events, 1):
        eid = str(e["id"])
        out_path = os.path.join(CACHE, f"{eid}.json")
        if os.path.exists(out_path):
            skipped += 1
            continue

        t = datetime.fromisoformat(e["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
        start = t - timedelta(minutes=PRE_MIN)
        end = t + timedelta(minutes=POST_MIN)

        try:
            eurusd = _compact_ba(fetch_candles("EUR_USD", "M1", start, end, price="BA"))
            us2y = _compact_mid(fetch_candles("USB02Y_USD", "M1", start, end, price="M"))
            us10y = _compact_mid(fetch_candles("USB10Y_USD", "M1", start, end, price="M"))
        except Exception as exc:  # one bad event must not kill the whole run
            print(f"  ! skip {eid} ({e.get('date')}): {exc}")
            continue

        rec = {"id": eid, "date": e["date"], "eurusd": eurusd, "us2y": us2y, "us10y": us10y}
        with open(out_path, "w") as f:
            json.dump(rec, f)

        done += 1
        if not eurusd:
            empty += 1
        if i % 25 == 0 or i == len(events):
            print(f"  {i}/{len(events)}  new={done} skip={skipped} empty_eurusd={empty}")

    print(f"Done. new={done} skipped={skipped} empty_eurusd={empty}")


if __name__ == "__main__":
    main()
