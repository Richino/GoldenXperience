"""
OANDA candle client (stdlib only). Reads credentials from api-server/.env.

Fetches BID/ASK candles (price=BA) so the backtest can execute against real
spread — never midpoint-only. Yields are fetched as mid (price=M); they feed
pre-event features only, not execution.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.normpath(os.path.join(HERE, "..", "..", ".env"))


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_ENV = _load_env()
_TOKEN = (_ENV.get("OANDA_API_KEY") or _ENV.get("OANDA_API_TOKEN") or "").strip()
_ENVIRONMENT = "live" if _ENV.get("OANDA_ENVIRONMENT") == "live" else "practice"
_BASE = (
    "https://api-fxtrade.oanda.com"
    if _ENVIRONMENT == "live"
    else "https://api-fxpractice.oanda.com"
)

if not _TOKEN:
    raise RuntimeError(f"OANDA_API_KEY not found in {ENV_PATH}")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")


def fetch_candles(
    instrument: str,
    granularity: str,
    start: datetime,
    end: datetime,
    price: str = "BA",
    retries: int = 4,
) -> list[dict]:
    """
    Candles for [start, end]. price='BA' -> each candle has bid & ask OHLC;
    price='M' -> mid only. Returns [] on a hard 'instrument/range' error so a
    missing series (e.g. a yield with shorter history) degrades gracefully.
    """
    params = (
        f"price={price}&granularity={granularity}"
        f"&from={_iso(start)}&to={_iso(end)}"
    )
    url = f"{_BASE}/v3/instruments/{instrument}/candles?{params}"
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"Authorization": f"Bearer {_TOKEN}"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data.get("candles", [])
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "ignore")[:200]
            if exc.code == 400:
                # Bad range / unknown instrument: not retryable, degrade.
                return []
            if exc.code == 429 or 500 <= exc.code < 600:
                last = f"{exc.code}: {body}"
                time.sleep(1.0 * (attempt + 1))
                continue
            raise RuntimeError(f"OANDA {instrument} {exc.code}: {body}")
        except (urllib.error.URLError, TimeoutError) as exc:
            last = exc
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"OANDA request failed after retries: {last}")


def environment() -> str:
    return _ENVIRONMENT


if __name__ == "__main__":
    # Smoke test.
    from datetime import timedelta

    t = datetime(2025, 1, 10, 13, 30, tzinfo=timezone.utc)  # an NFP release
    ba = fetch_candles("EUR_USD", "M1", t - timedelta(minutes=5), t + timedelta(minutes=5))
    print(f"env={_ENVIRONMENT} EUR_USD candles={len(ba)}")
    if ba:
        c = ba[len(ba) // 2]
        print("sample:", json.dumps(c))
    for y in ("USB02Y_USD", "USB10Y_USD"):
        cs = fetch_candles(y, "M1", t - timedelta(minutes=5), t + timedelta(minutes=5), price="M")
        print(f"{y}: {len(cs)} candles")
