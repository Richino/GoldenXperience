"""
direction-return-v3 — point-in-time rate/yield ingest. RESEARCH ONLY.

SOURCES AND SUBSTITUTIONS (documented, not fabricated)

The brief asks for comparable 2-year yields for USD/EUR/GBP/JPY. FRED carries a
daily 2Y only for the US. Probing FRED for daily short-end series in the other
three returned:
    EUR  ECBDFR    ECB Deposit Facility Rate        DAILY   available
    GBP  IUDSOIA   Sterling Overnight Index (SONIA) DAILY   available
    JPY  -         no daily series exists on FRED   MONTHLY only

So a genuine cross-currency 2Y set is not obtainable here. The most COMPARABLE
set that is actually available is policy/overnight rates, which exist daily for
three of the four:

    USD  DFF                Federal Funds Effective Rate        daily
    EUR  ECBDFR             ECB Deposit Facility Rate           daily
    GBP  IUDSOIA            SONIA overnight                     daily
    JPY  IRSTCI01JPM156N    Immediate rate (<24h)   MONTHLY  <-- SUBSTITUTION

USD 2Y (DGS2) is carried alongside as a market-yield feature for the USD leg,
clearly separated from the policy set so the two are never differenced together.

POINT-IN-TIME RULE
  daily series   availableAt = observation date + 1 calendar day
  monthly series availableAt = first day of the FOLLOWING month
Both are deliberately conservative. Where publication timing is uncertain the
feature is lagged rather than risked, per the brief.

A KNOWN LIMITATION, STATED UP FRONT: these series update daily at best, while
the prediction horizons run from 15 minutes to 6 hours. A daily variable is
constant across an intraday horizon, so the LEVEL cannot discriminate between
bars within a day. Only the multi-day CHANGES can carry information, and even
those move slowly relative to the target. This is tested, not assumed.
"""
import json, os, re, sys, urllib.request, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEY = re.search(r"FRED_API_KEY=(\S+)", (ROOT / ".env.local").read_text()).group(1)
OUT = Path(os.environ.get("OUT", ROOT.parent / "v3-rates.jsonl"))

SERIES = [
    ("USD", "DFF", "daily", "policy"),
    ("EUR", "ECBDFR", "daily", "policy"),
    ("GBP", "IUDSOIA", "daily", "policy"),
    ("JPY", "IRSTCI01JPM156N", "monthly", "policy"),
    ("USD", "DGS2", "daily", "yield2y"),
]


def fetch(series_id):
    url = (f"https://api.stlouisfed.org/fred/series/observations?series_id={series_id}"
           f"&api_key={KEY}&file_type=json&observation_start=2021-01-01")
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)["observations"]


def available_at(obs_date: str, freq: str) -> str:
    d = dt.date.fromisoformat(obs_date)
    if freq == "daily":
        return (d + dt.timedelta(days=1)).isoformat() + "T00:00:00Z"
    nxt = (d.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
    return nxt.isoformat() + "T00:00:00Z"


rows = []
for ccy, sid, freq, kind in SERIES:
    obs = fetch(sid)
    kept = 0
    for o in obs:
        if o["value"] == ".":
            continue
        rows.append(dict(currency=ccy, seriesId=sid, kind=kind, frequency=freq,
                         observationDate=o["date"], availableAt=available_at(o["date"], freq),
                         value=float(o["value"]), source="fred"))
        kept += 1
    span = [o["date"] for o in obs if o["value"] != "."]
    print(f"{ccy:<4} {sid:<18} {freq:<8} {kind:<8} n={kept:<6} {span[0]} .. {span[-1]}")

OUT.write_text("\n".join(json.dumps(r) for r in rows))
print(f"\nwrote {len(rows)} observations -> {OUT}")
