#!/usr/bin/env python3
"""Strict chronological forced-direction search over frozen binary snapshots."""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.svm import SVC


SEED = 20260826
PAYOUT_GATE = 1.0 / 1.8
MIN_DEV_DECIDED = 100
HORIZONS = ("m1", "m5", "m10", "m15")
CATEGORICAL = ("instrument", "base", "quote", "session", "time_bucket", "trend", "weekday")


def finite(value: Any) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else math.nan
    except (TypeError, ValueError):
        return math.nan


def pip_size(instrument: str) -> float:
    return 0.01 if "JPY" in instrument else 0.0001


def split_pair(instrument: str) -> tuple[str, str]:
    parts = instrument.split("_", 1)
    return (parts[0], parts[1]) if len(parts) == 2 else (instrument, "UNKNOWN")


def official_target(row: dict[str, Any]) -> float:
    result = row.get("result")
    if result == "tie":
        return math.nan
    direction = row.get("direction")
    if direction == "up":
        return 1.0 if result == "won" else 0.0
    return 0.0 if result == "won" else 1.0


def numeric_target(row: dict[str, Any]) -> float:
    precision = int(row.get("price_precision") or 5)
    tolerance_ticks = int(row.get("tie_tolerance") or 0)
    entry = round(finite(row.get("entry_price")), precision)
    resolution = round(finite(row.get("resolution_price")), precision)
    tolerance = tolerance_ticks * (10 ** -precision)
    if not math.isfinite(entry) or not math.isfinite(resolution):
        return math.nan
    if abs(resolution - entry) <= tolerance:
        return math.nan
    return 1.0 if resolution > entry else 0.0


def rate(values: deque[float], n: int) -> float:
    if not values:
        return math.nan
    subset = list(values)[-n:]
    return float(np.mean(subset)) if subset else math.nan


def signed_streak(values: deque[float]) -> float:
    if not values:
        return math.nan
    last = values[-1]
    count = 0
    for value in reversed(values):
        if value != last:
            break
        count += 1
    return float(count if last > 0.5 else -count)


def build_frame(rows: list[dict[str, Any]]) -> tuple[pd.DataFrame, dict[str, Any]]:
    ordered = sorted(rows, key=lambda r: (pd.Timestamp(r["start_at"]), r["instrument"], str(r["id"])))
    records: list[dict[str, Any]] = []
    label_mismatches = 0
    unsafe_candle_rows = 0

    for row in ordered:
        f = row.get("features") or {}
        context = row.get("market_context") or {}
        instrument = str(row["instrument"])
        base, quote = split_pair(instrument)
        pip = pip_size(instrument)
        start = pd.Timestamp(row["start_at"])
        resolved = pd.Timestamp(row["resolved_at"])
        reference_time = pd.Timestamp(f.get("referenceCloseTime"))
        target = official_target(row)
        numeric = numeric_target(row)
        if (math.isnan(target) != math.isnan(numeric)) or (
            math.isfinite(target) and math.isfinite(numeric) and target != numeric
        ):
            label_mismatches += 1

        candle_safe = pd.notna(reference_time) and reference_time + pd.Timedelta(minutes=1) <= start
        if not candle_safe:
            unsafe_candle_rows += 1

        momentum = f.get("momentumPips") or {}
        returns = f.get("returnPct") or {}
        candle = f.get("candle") or {}
        atr = finite(f.get("atrPips"))
        ema_fast = finite(f.get("emaFast"))
        ema_slow = finite(f.get("emaSlow"))
        reference_close = finite(f.get("referenceClose"))
        entry = finite(row.get("entry_price"))
        dist_high = finite(f.get("distanceFromHighPips"))
        dist_low = finite(f.get("distanceFromLowPips"))
        upper_wick = finite(candle.get("upperWickPips"))
        lower_wick = finite(candle.get("lowerWickPips"))
        start_hour = start.hour + start.minute / 60.0 + start.second / 3600.0
        weekday = start.day_name()[:3]

        rec: dict[str, Any] = {
            "id": str(row["id"]),
            "opportunity_key": str(row.get("opportunity_key") or row["id"]),
            "start": start,
            "resolved": resolved,
            "reference_time": reference_time,
            "instrument": instrument,
            "base": base,
            "quote": quote,
            "session": str(f.get("session") or context.get("session") or "Unknown"),
            "time_bucket": str(f.get("timeOfDayBucket") or "Unknown"),
            "trend": str(f.get("trend") or "flat"),
            "weekday": weekday,
            "recorded_direction": 1 if row.get("direction") == "up" else 0,
            "baseline_confidence": finite(row.get("confidence")),
            "target": target,
            "candle_safe": candle_safe,
            "resolution_source": str(row.get("resolution_source") or "unknown"),
            "hour_sin": math.sin(2 * math.pi * start_hour / 24),
            "hour_cos": math.cos(2 * math.pi * start_hour / 24),
            "weekday_sin": math.sin(2 * math.pi * start.dayofweek / 7),
            "weekday_cos": math.cos(2 * math.pi * start.dayofweek / 7),
            "minute_sin": math.sin(2 * math.pi * start.minute / 60),
            "minute_cos": math.cos(2 * math.pi * start.minute / 60),
            "second_sin": math.sin(2 * math.pi * start.second / 60),
            "second_cos": math.cos(2 * math.pi * start.second / 60),
            "atr_pips": atr,
            "volatility_pips": finite(f.get("volatilityPips")),
            "body_pips": finite(candle.get("bodyPips")),
            "body_ratio": finite(candle.get("bodyRatio")),
            "upper_wick": upper_wick,
            "lower_wick": lower_wick,
            "dist_high": dist_high,
            "dist_low": dist_low,
            "spread_pips": finite(f.get("spreadPips")),
            "ema_gap_pips": (ema_fast - ema_slow) / pip if math.isfinite(ema_fast) and math.isfinite(ema_slow) else math.nan,
            "ema_gap_atr": (ema_fast - ema_slow) / (pip * atr) if math.isfinite(ema_fast) and math.isfinite(ema_slow) and atr > 0 else math.nan,
            "entry_gap_pips": (entry - reference_close) / pip if math.isfinite(entry) and math.isfinite(reference_close) else math.nan,
            "quote_age_seconds": (start - reference_time).total_seconds() if pd.notna(reference_time) else math.nan,
            "range_position": (dist_low - dist_high) / (dist_low + dist_high) if math.isfinite(dist_low) and math.isfinite(dist_high) and dist_low + dist_high > 0 else math.nan,
            "wick_imbalance": (lower_wick - upper_wick) / (lower_wick + upper_wick) if math.isfinite(lower_wick) and math.isfinite(upper_wick) and lower_wick + upper_wick > 0 else math.nan,
            "pip_fraction": (entry / pip) % 1 if math.isfinite(entry) else math.nan,
            "pipette_digit": math.floor(((entry / pip) % 1) * 10 + 1e-9) if math.isfinite(entry) else math.nan,
        }
        rec["baseline_signed_confidence"] = (1 if rec["recorded_direction"] else -1) * (
            rec["baseline_confidence"] - 0.5 if math.isfinite(rec["baseline_confidence"]) else 0.0
        )
        rec["trend_agrees_baseline"] = int(
            (rec["recorded_direction"] == 1 and rec["trend"] == "up")
            or (rec["recorded_direction"] == 0 and rec["trend"] == "down")
        )
        for horizon in HORIZONS:
            mom = finite(momentum.get(horizon))
            ret = finite(returns.get(horizon))
            rec[f"mom_{horizon}"] = mom
            rec[f"ret_{horizon}"] = ret
            rec[f"mom_atr_{horizon}"] = mom / atr if math.isfinite(mom) and atr > 0 else math.nan
        records.append(rec)

    if label_mismatches:
        raise RuntimeError(f"Official target disagrees with rounded entry/resolution on {label_mismatches} rows.")

    # Current cross-pair currency strength, derived only from frozen return features
    # sharing the same completed reference candle timestamp.
    grouped: dict[str, list[int]] = defaultdict(list)
    for index, rec in enumerate(records):
        grouped[str(rec["reference_time"])].append(index)
    for horizon in HORIZONS:
        for indices in grouped.values():
            sums: dict[str, float] = defaultdict(float)
            counts: dict[str, int] = defaultdict(int)
            row_return: dict[int, float] = {}
            for index in indices:
                rec = records[index]
                value = finite(rec[f"ret_{horizon}"])
                row_return[index] = value
                if not math.isfinite(value):
                    continue
                sums[rec["base"]] += value
                counts[rec["base"]] += 1
                sums[rec["quote"]] -= value
                counts[rec["quote"]] += 1
            for index in indices:
                rec = records[index]
                base = rec["base"]
                quote = rec["quote"]
                base_strength = sums[base] / counts[base] if counts[base] else math.nan
                quote_strength = sums[quote] / counts[quote] if counts[quote] else math.nan
                rec[f"cross_strength_{horizon}"] = base_strength - quote_strength
                own = row_return[index]
                base_n = counts[base] - (1 if math.isfinite(own) else 0)
                quote_n = counts[quote] - (1 if math.isfinite(own) else 0)
                base_sum = sums[base] - (own if math.isfinite(own) else 0)
                quote_sum = sums[quote] + (own if math.isfinite(own) else 0)
                base_loo = base_sum / base_n if base_n else math.nan
                quote_loo = quote_sum / quote_n if quote_n else math.nan
                rec[f"cross_strength_loo_{horizon}"] = base_loo - quote_loo if math.isfinite(base_loo) and math.isfinite(quote_loo) else math.nan

    # Past-only state: labels enter history only once their stored resolution has
    # completed. A current row can never see itself or an unresolved predecessor.
    pair_history: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=100))
    pair_correct_history: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=100))
    currency_history: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=200))
    pending: list[tuple[int, int, str, str, str, float, int]] = []
    sequence = 0
    by_start: dict[pd.Timestamp, list[int]] = defaultdict(list)
    for index, rec in enumerate(records):
        by_start[rec["start"]].append(index)
    for start in sorted(by_start):
        start_ns = int(start.value)
        while pending and pending[0][0] <= start_ns:
            _, _, instrument, base, quote, target, recorded_direction = heapq.heappop(pending)
            pair_history[instrument].append(target)
            pair_correct_history[instrument].append(float(int(target) == recorded_direction))
            signed = 1.0 if target > 0.5 else -1.0
            currency_history[base].append(signed)
            currency_history[quote].append(-signed)
        for index in by_start[start]:
            rec = records[index]
            history = pair_history[rec["instrument"]]
            correct_history = pair_correct_history[rec["instrument"]]
            rec["last_pair_sign"] = (history[-1] * 2 - 1) if history else math.nan
            rec["pair_streak"] = signed_streak(history)
            for window in (5, 10, 25, 50):
                rec[f"pair_up_rate_{window}"] = rate(history, window)
                rec[f"pair_correct_rate_{window}"] = rate(correct_history, window)
            rec["last_pair_correct"] = correct_history[-1] if correct_history else math.nan
            rec["pair_correct_streak"] = signed_streak(correct_history)
            for window in (20, 50):
                base_strength = rate(currency_history[rec["base"]], window)
                quote_strength = rate(currency_history[rec["quote"]], window)
                rec[f"past_currency_diff_{window}"] = base_strength - quote_strength if math.isfinite(base_strength) and math.isfinite(quote_strength) else math.nan
        for index in by_start[start]:
            rec = records[index]
            if math.isfinite(rec["target"]):
                heapq.heappush(
                    pending,
                    (
                        int(rec["resolved"].value), sequence, rec["instrument"], rec["base"], rec["quote"],
                        rec["target"], rec["recorded_direction"],
                    ),
                )
                sequence += 1

    frame = pd.DataFrame.from_records(records)
    audit = {
        "inputRows": len(ordered),
        "unsafeCandleRows": unsafe_candle_rows,
        "labelMismatches": label_mismatches,
        "duplicateOpportunities": int(frame["opportunity_key"].duplicated().sum()),
    }
    return frame, audit


def wilson(wins: int, n: int) -> tuple[float, float]:
    if n <= 0:
        return (math.nan, math.nan)
    z = 1.96
    p = wins / n
    denominator = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return ((center - margin) / denominator, (center + margin) / denominator)


def metrics(prediction: np.ndarray, target: np.ndarray) -> dict[str, Any]:
    decided = np.isfinite(target)
    wins = int(np.sum(prediction[decided] == target[decided]))
    n = int(np.sum(decided))
    ties = int(len(target) - n)
    low, high = wilson(wins, n)
    return {
        "rows": int(len(target)),
        "decided": n,
        "wins": wins,
        "losses": n - wins,
        "ties": ties,
        "wr": wins / n if n else math.nan,
        "ciLow": low,
        "ciHigh": high,
    }


def hash_random(ids: pd.Series) -> np.ndarray:
    values = []
    for row_id in ids.astype(str):
        digest = hashlib.sha256(f"{SEED}:{row_id}".encode("utf-8")).digest()
        values.append(digest[0] & 1)
    return np.asarray(values, dtype=int)


def sign_prediction(values: pd.Series, fallback: int) -> np.ndarray:
    numeric = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
    return np.where(np.isfinite(numeric) & (numeric > 0), 1, np.where(np.isfinite(numeric) & (numeric < 0), 0, fallback)).astype(int)


def majority_state(train: pd.DataFrame, keys: list[str]) -> dict[str, Any]:
    decided = train[np.isfinite(train["target"])]
    fallback = int(decided["target"].mean() >= 0.5)
    mapping: dict[tuple[Any, ...], int] = {}
    grouped = decided.groupby(keys, dropna=False)["target"].mean()
    for key, value in grouped.items():
        normalized = key if isinstance(key, tuple) else (key,)
        mapping[tuple(str(item) for item in normalized)] = int(value >= 0.5)
    return {"kind": "majority", "keys": keys, "mapping": mapping, "fallback": fallback}


def predict_state(state: dict[str, Any], frame: pd.DataFrame) -> np.ndarray:
    kind = state["kind"]
    if kind in ("learned", "correctness_learned"):
        matrix = state["preprocessor"].transform(frame[state["columns"]])
        raw_prediction = state["model"].predict(matrix).astype(int)
        if kind == "correctness_learned":
            baseline = frame["recorded_direction"].to_numpy(dtype=int)
            prediction = np.where(raw_prediction.astype(bool), baseline, 1 - baseline).astype(int)
        else:
            prediction = raw_prediction
    elif kind == "sign":
        values = frame[state["column"]] - float(state.get("center", 0.0))
        prediction = sign_prediction(values, int(state["fallback"]))
    elif kind == "majority":
        mapping = state["mapping"]
        fallback = int(state["fallback"])
        prediction = np.asarray([
            mapping.get(tuple(str(row[key]) for key in state["keys"]), fallback)
            for _, row in frame.iterrows()
        ], dtype=int)
    elif kind == "follow_signal":
        values = pd.to_numeric(frame[state["column"]], errors="coerce").to_numpy(dtype=float)
        center = float(state.get("center", 0.5))
        follow = np.where(np.isfinite(values), values >= center, bool(state.get("fallbackFollow", True)))
        baseline = frame["recorded_direction"].to_numpy(dtype=int)
        prediction = np.where(follow, baseline, 1 - baseline).astype(int)
    else:
        raise ValueError(f"Unknown state kind: {kind}")
    if state.get("inverse"):
        prediction = 1 - prediction
    return prediction


def add_orientations(
    candidates: list[dict[str, Any]],
    states: dict[str, dict[str, Any]],
    base_name: str,
    train_prediction: np.ndarray,
    dev_prediction: np.ndarray,
    train_target: np.ndarray,
    dev_target: np.ndarray,
    state: dict[str, Any],
) -> None:
    for inverse in (False, True):
        name = f"{base_name}::{ 'inverse' if inverse else 'original' }"
        oriented_train = 1 - train_prediction if inverse else train_prediction
        oriented_dev = 1 - dev_prediction if inverse else dev_prediction
        candidate = {
            "name": name,
            "baseName": base_name,
            "inverse": inverse,
            "train": metrics(oriented_train, train_target),
            "dev": metrics(oriented_dev, dev_target),
        }
        candidates.append(candidate)
        states[name] = {**state, "inverse": inverse}


def preprocess(train: pd.DataFrame, dev: pd.DataFrame, columns: list[str]) -> tuple[ColumnTransformer, np.ndarray, np.ndarray]:
    categorical = [column for column in columns if column in CATEGORICAL]
    numeric = [column for column in columns if column not in categorical]
    transformer = ColumnTransformer(
        transformers=[
            ("numeric", Pipeline([
                ("impute", SimpleImputer(strategy="median")),
                ("scale", StandardScaler()),
            ]), numeric),
            ("categorical", Pipeline([
                ("impute", SimpleImputer(strategy="most_frequent")),
                ("encode", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
            ]), categorical),
        ],
        remainder="drop",
        sparse_threshold=0.0,
    )
    train_matrix = transformer.fit_transform(train[columns])
    dev_matrix = transformer.transform(dev[columns])
    return transformer, np.asarray(train_matrix), np.asarray(dev_matrix)


def learned_specs() -> list[tuple[str, str, Callable[[], Any]]]:
    specs: list[tuple[str, str, Callable[[], Any]]] = []
    for feature_set in ("base", "full"):
        for c_value in (0.01, 0.1, 1.0, 10.0):
            specs.append((feature_set, f"logistic_C{c_value:g}", lambda c=c_value: LogisticRegression(C=c, max_iter=3000, random_state=SEED)))
    for depth in (3, 6, None):
        for leaf in (10, 30):
            specs.append(("full", f"extra_depth{depth}_leaf{leaf}", lambda d=depth, l=leaf: ExtraTreesClassifier(
                n_estimators=300, max_depth=d, min_samples_leaf=l, max_features="sqrt", random_state=SEED, n_jobs=-1,
            )))
    for depth in (3, 6):
        for leaf in (10, 30):
            specs.append(("full", f"forest_depth{depth}_leaf{leaf}", lambda d=depth, l=leaf: RandomForestClassifier(
                n_estimators=300, max_depth=d, min_samples_leaf=l, max_features="sqrt", random_state=SEED, n_jobs=-1,
            )))
    for leaves in (7, 15, 31):
        for l2 in (1.0, 10.0):
            specs.append(("full", f"histgb_leaves{leaves}_l2{l2:g}", lambda n=leaves, penalty=l2: HistGradientBoostingClassifier(
                max_iter=200, learning_rate=0.05, max_leaf_nodes=n, min_samples_leaf=30, l2_regularization=penalty, random_state=SEED,
            )))
    for neighbors in (15, 31, 63):
        specs.append(("full", f"knn_{neighbors}", lambda n=neighbors: KNeighborsClassifier(n_neighbors=n, weights="distance")))
    for c_value in (0.1, 1.0, 10.0):
        specs.append(("full", f"rbf_svc_C{c_value:g}", lambda c=c_value: SVC(C=c, kernel="rbf", gamma="scale")))
    return specs


def correctness_specs() -> list[tuple[str, Callable[[], Any]]]:
    specs: list[tuple[str, Callable[[], Any]]] = []
    for c_value in (0.01, 0.1, 1.0, 10.0):
        specs.append((f"logistic_C{c_value:g}", lambda c=c_value: LogisticRegression(C=c, max_iter=3000, random_state=SEED)))
    for depth in (3, 6, None):
        for leaf in (10, 30):
            specs.append((f"extra_depth{depth}_leaf{leaf}", lambda d=depth, l=leaf: ExtraTreesClassifier(
                n_estimators=300, max_depth=d, min_samples_leaf=l, max_features="sqrt", random_state=SEED, n_jobs=-1,
            )))
    for depth in (3, 6):
        for leaf in (10, 30):
            specs.append((f"forest_depth{depth}_leaf{leaf}", lambda d=depth, l=leaf: RandomForestClassifier(
                n_estimators=300, max_depth=d, min_samples_leaf=l, max_features="sqrt", random_state=SEED, n_jobs=-1,
            )))
    for leaves in (7, 15, 31):
        for l2 in (1.0, 10.0):
            specs.append((f"histgb_leaves{leaves}_l2{l2:g}", lambda n=leaves, penalty=l2: HistGradientBoostingClassifier(
                max_iter=200, learning_rate=0.05, max_leaf_nodes=n, min_samples_leaf=30, l2_regularization=penalty, random_state=SEED,
            )))
    for c_value in (0.1, 1.0, 10.0):
        specs.append((f"rbf_svc_C{c_value:g}", lambda c=c_value: SVC(C=c, kernel="rbf", gamma="scale")))
    return specs


def fmt_pct(value: float) -> str:
    return "n/a" if not math.isfinite(value) else f"{100 * value:.2f}%"


def metric_line(label: str, value: dict[str, Any]) -> str:
    return (
        f"{label}: {value['wins']}W/{value['losses']}L/{value['ties']}T "
        f"on {value['rows']} forced predictions; WR={fmt_pct(value['wr'])}; "
        f"Wilson95=[{fmt_pct(value['ciLow'])}, {fmt_pct(value['ciHigh'])}]"
    )


def write_discovery_report(
    report_path: Path,
    payload: dict[str, Any],
    audit: dict[str, Any],
    frame: pd.DataFrame,
    train: pd.DataFrame,
    dev: pd.DataFrame,
    candidates: list[dict[str, Any]],
    selected: dict[str, Any],
    gate_passed: bool,
    control_rows: list[tuple[str, dict[str, Any]]],
) -> None:
    metadata = payload["metadata"]
    lines = [
        "GOLDENXPERIENCE — BINARY CONTEXT ENSEMBLE V1",
        "=" * 72,
        "",
        "DIRECT RESULT",
        "-------------",
        (
            f"DEV GATE PASSED by {selected['name']}; HOLDOUT was then eligible to open."
            if gate_passed
            else "NO SETUP PASSED THE DEV GATE. HOLDOUT OUTCOMES WERE NOT QUERIED OR READ."
        ),
        "",
        "WHAT WAS DIFFERENT",
        "------------------",
        "This forced-direction search added information omitted by the old 25-feature model:",
        "entry quote vs last completed M1 close, pair/currency identity, synchronized",
        "cross-pair currency strength, time phase, price microstructure, and strictly",
        "past-resolved pair/currency outcome state. It also models FOLLOW versus INVERT",
        "directly from baseline direction/confidence and prior correctness. Every arm",
        "outputs UP or DOWN; no WAIT.",
        "",
        "COHORT AND INTEGRITY",
        "--------------------",
        f"Cohort: {metadata['cohort']}",
        f"Full cohort metadata count: {metadata['totalCohortRows']}",
        f"TRAIN boundary: {metadata['trainBoundary']}",
        f"HOLDOUT boundary: {metadata['holdoutBoundary']}",
        f"Boundary purge: {metadata['purgeMinutes']} minutes",
        f"Rows loaded in discovery query: {audit['inputRows']}",
        f"Rows excluded because reference M1 was not fully closed at entry: {audit['unsafeCandleRows']}",
        f"Official-vs-price target mismatches: {audit['labelMismatches']}",
        f"Duplicate opportunity keys: {audit['duplicateOpportunities']}",
        f"Eligible TRAIN rows after safety/purge: {len(train)}",
        f"Eligible DEV rows after safety/purge: {len(dev)}",
        f"Candidate orientations tested on the same DEV rows: {len(candidates)}",
        "Feature imputation, scaling, one-hot vocabularies, model parameters, and",
        "pair/time majority maps were fit on TRAIN only. Same-start clusters stay together.",
        "",
        "PREDECLARED DISCOVERY GATE",
        "--------------------------",
        f"n >= {MIN_DEV_DECIDED}; DEV WR > {100 * PAYOUT_GATE:.2f}%; Wilson lower bound > 50%.",
        "The 55.56% threshold corresponds to break-even at an 80% binary payout.",
        "Because many candidates share one DEV set, any pass still requires untouched HOLDOUT confirmation.",
        "",
        "SELECTED DEV CANDIDATE",
        "----------------------",
        f"Name: {selected['name']}",
        metric_line("TRAIN", selected["train"]),
        metric_line("DEV", selected["dev"]),
        f"Gate passed: {'YES' if gate_passed else 'NO'}",
        "",
        "TOP DEV LEADERBOARD",
        "-------------------",
        "rank | candidate | train WR | dev WR | dev Wilson low | dev n",
    ]
    for rank, candidate in enumerate(candidates[:25], start=1):
        lines.append(
            f"{rank:>4} | {candidate['name']} | {fmt_pct(candidate['train']['wr'])} | "
            f"{fmt_pct(candidate['dev']['wr'])} | {fmt_pct(candidate['dev']['ciLow'])} | {candidate['dev']['decided']}"
        )
    lines.extend([
        "",
        "FIXED CONTROLS ON DEV",
        "---------------------",
    ])
    for name, value in control_rows:
        lines.append(metric_line(name, value))
    lines.extend([
        "",
        "HOLDOUT STATUS",
        "--------------",
        "ELIGIBLE TO OPEN" if gate_passed else "NOT QUERIED / NOT READ",
        "",
        "LIMITATIONS",
        "-----------",
        "- This is only the baseline-triggered opportunity cohort, not every market minute.",
        "- The dataset spans less than two weeks; day/regime independence is limited.",
        "- AUD_JPY and EUR_AUD entered the cohort later than the other ten pairs.",
        "- Wilson intervals treat rows as independent even though simultaneous FX pairs correlate.",
        "- features and market_context are internally decision-time-consistent but are not",
        "  protected as immutable columns by the current database trigger.",
        "- DEV is a model-selection set. Its best row is biased upward by candidate search.",
        "",
        "DECISION",
        "--------",
        (
            "The selected setup earned the right to a one-time HOLDOUT check; it is not activated."
            if gate_passed
            else "Do not activate or invert any tested setup. No materially good or bad forced-direction signal was found on DEV."
        ),
        "",
    ])
    report_path.write_text("\n".join(lines), encoding="utf-8")


def discovery(payload: dict[str, Any], state_path: Path, report_path: Path) -> dict[str, Any]:
    frame, audit = build_frame(payload["rows"])
    metadata = payload["metadata"]
    train_boundary = pd.Timestamp(metadata["trainBoundary"])
    holdout_boundary = pd.Timestamp(metadata["holdoutBoundary"])
    purge = pd.Timedelta(minutes=int(metadata["purgeMinutes"]))
    safe = frame[frame["candle_safe"]].copy()
    train = safe[safe["start"] < train_boundary - purge].copy()
    dev = safe[(safe["start"] >= train_boundary) & (safe["start"] < holdout_boundary - purge)].copy()
    if len(train) < 500 or len(dev) < 100:
        raise RuntimeError(f"Insufficient chronological split after purge: train={len(train)} dev={len(dev)}")

    target_train = train["target"].to_numpy(dtype=float)
    target_dev = dev["target"].to_numpy(dtype=float)
    decided_train = np.isfinite(target_train)
    fallback = int(np.nanmean(target_train) >= 0.5)

    excluded = {
        "id", "opportunity_key", "start", "resolved", "reference_time", "target",
        "candle_safe", "recorded_direction", "resolution_source",
    }
    numeric_all = [
        column for column in frame.columns
        if column not in excluded and column not in CATEGORICAL and pd.api.types.is_numeric_dtype(frame[column])
    ]
    base_numeric = [
        column for column in numeric_all
        if column.startswith(("mom_", "ret_"))
        or column in {
            "atr_pips", "volatility_pips", "body_pips", "body_ratio", "upper_wick", "lower_wick",
            "dist_high", "dist_low", "spread_pips", "ema_gap_pips", "hour_sin", "hour_cos",
        }
    ]
    feature_columns = {
        "base": sorted(set(base_numeric + ["instrument", "session", "trend"])),
        "full": sorted(set(numeric_all + list(CATEGORICAL))),
    }
    correctness_columns = sorted(set(feature_columns["full"] + [
        "recorded_direction", "baseline_confidence", "baseline_signed_confidence", "trend_agrees_baseline",
        "last_pair_correct", "pair_correct_streak",
        *[f"pair_correct_rate_{n}" for n in (5, 10, 25, 50)],
    ]))

    transformed: dict[str, tuple[ColumnTransformer, np.ndarray, np.ndarray]] = {}
    for feature_set, columns in feature_columns.items():
        transformed[feature_set] = preprocess(train, dev, columns)
    transformed["correctness"] = preprocess(train, dev, correctness_columns)

    candidates: list[dict[str, Any]] = []
    states: dict[str, dict[str, Any]] = {}

    signal_columns = [
        "entry_gap_pips", "ema_gap_pips", "range_position", "wick_imbalance",
        "last_pair_sign", "pair_streak",
        *[f"mom_{h}" for h in HORIZONS],
        *[f"cross_strength_{h}" for h in HORIZONS],
        *[f"cross_strength_loo_{h}" for h in HORIZONS],
        *[f"pair_up_rate_{n}" for n in (5, 10, 25, 50)],
        *[f"past_currency_diff_{n}" for n in (20, 50)],
    ]
    for column in signal_columns:
        if column.startswith("pair_up_rate_"):
            state = {"kind": "sign", "column": column, "center": 0.5, "fallback": fallback}
        else:
            state = {"kind": "sign", "column": column, "fallback": fallback}
        train_prediction = predict_state(state, train)
        dev_prediction = predict_state(state, dev)
        add_orientations(candidates, states, f"sign_{column}", train_prediction, dev_prediction, target_train, target_dev, state)

    for keys in (["instrument"], ["instrument", "time_bucket"], ["instrument", "weekday"], ["base"], ["quote"]):
        state = majority_state(train, list(keys))
        base_name = "majority_" + "_".join(keys)
        add_orientations(
            candidates, states, base_name,
            predict_state(state, train), predict_state(state, dev),
            target_train, target_dev, state,
        )

    for column in ("last_pair_correct", "pair_correct_streak", *[f"pair_correct_rate_{n}" for n in (5, 10, 25, 50)]):
        state = {
            "kind": "follow_signal",
            "column": column,
            "center": 0.0 if column == "pair_correct_streak" else 0.5,
            "fallbackFollow": True,
        }
        add_orientations(
            candidates, states, f"follow_invert_{column}",
            predict_state(state, train), predict_state(state, dev),
            target_train, target_dev, state,
        )

    for feature_set, model_name, factory in learned_specs():
        preprocessor, train_matrix, dev_matrix = transformed[feature_set]
        model = factory()
        model.fit(train_matrix[decided_train], target_train[decided_train].astype(int))
        train_prediction = model.predict(train_matrix).astype(int)
        dev_prediction = model.predict(dev_matrix).astype(int)
        state = {
            "kind": "learned",
            "preprocessor": preprocessor,
            "model": model,
            "columns": feature_columns[feature_set],
        }
        add_orientations(
            candidates, states, f"{feature_set}_{model_name}",
            train_prediction, dev_prediction, target_train, target_dev, state,
        )

    correctness_train = (target_train == train["recorded_direction"].to_numpy(dtype=int)).astype(int)
    correctness_dev = (target_dev == dev["recorded_direction"].to_numpy(dtype=int)).astype(int)
    correctness_transformer, correctness_train_matrix, correctness_dev_matrix = transformed["correctness"]
    baseline_train = train["recorded_direction"].to_numpy(dtype=int)
    baseline_dev = dev["recorded_direction"].to_numpy(dtype=int)
    for model_name, factory in correctness_specs():
        model = factory()
        model.fit(correctness_train_matrix[decided_train], correctness_train[decided_train])
        follow_train = model.predict(correctness_train_matrix).astype(bool)
        follow_dev = model.predict(correctness_dev_matrix).astype(bool)
        train_prediction = np.where(follow_train, baseline_train, 1 - baseline_train).astype(int)
        dev_prediction = np.where(follow_dev, baseline_dev, 1 - baseline_dev).astype(int)
        state = {
            "kind": "correctness_learned",
            "preprocessor": correctness_transformer,
            "model": model,
            "columns": correctness_columns,
        }
        add_orientations(
            candidates, states, f"correctness_{model_name}",
            train_prediction, dev_prediction, target_train, target_dev, state,
        )

    candidates.sort(key=lambda item: (item["dev"]["wr"], item["dev"]["ciLow"], item["name"]), reverse=True)
    selected = candidates[0]
    gate_passed = (
        selected["dev"]["decided"] >= MIN_DEV_DECIDED
        and selected["dev"]["wr"] > PAYOUT_GATE
        and selected["dev"]["ciLow"] > 0.50
    )

    controls = [
        ("recorded baseline", metrics(dev["recorded_direction"].to_numpy(dtype=int), target_dev)),
        ("exact baseline inverse", metrics(1 - dev["recorded_direction"].to_numpy(dtype=int), target_dev)),
        ("always UP", metrics(np.ones(len(dev), dtype=int), target_dev)),
        ("always DOWN", metrics(np.zeros(len(dev), dtype=int), target_dev)),
        ("seeded random", metrics(hash_random(dev["id"]), target_dev)),
    ]

    state = {
        "experiment": payload["experiment"],
        "metadata": metadata,
        "audit": audit,
        "selected": selected,
        "selectedState": states[selected["name"]],
        "leaderboard": candidates[:25],
        "candidateCount": len(candidates),
        "controls": controls,
        "trainRows": len(train),
        "devRows": len(dev),
        "gatePassed": gate_passed,
    }
    joblib.dump(state, state_path)
    write_discovery_report(report_path, payload, audit, frame, train, dev, candidates, selected, gate_passed, controls)
    return {
        "gatePassed": gate_passed,
        "selected": selected["name"],
        "devWinRate": selected["dev"]["wr"],
        "devWilsonLow": selected["dev"]["ciLow"],
    }


def holdout(payload: dict[str, Any], state_path: Path, report_path: Path) -> dict[str, Any]:
    state = joblib.load(state_path)
    if not state.get("gatePassed"):
        raise RuntimeError("HOLDOUT phase requested even though DEV gate did not pass.")
    frame, audit = build_frame(payload["rows"])
    holdout_boundary = pd.Timestamp(payload["metadata"]["holdoutBoundary"])
    holdout_frame = frame[(frame["candle_safe"]) & (frame["start"] >= holdout_boundary)].copy()
    target = holdout_frame["target"].to_numpy(dtype=float)
    prediction = predict_state(state["selectedState"], holdout_frame)
    selected_metric = metrics(prediction, target)
    inverse_metric = metrics(1 - prediction, target)
    confirmation = (
        selected_metric["decided"] >= MIN_DEV_DECIDED
        and selected_metric["wr"] > PAYOUT_GATE
        and selected_metric["ciLow"] > 0.50
    )

    existing = report_path.read_text(encoding="utf-8").rstrip()
    lines = [
        existing,
        "",
        "HOLDOUT RESULT (OPENED ONCE AFTER DEV PASS)",
        "-------------------------------------------",
        f"Selected frozen candidate: {state['selected']['name']}",
        metric_line("Selected", selected_metric),
        metric_line("Exact inverse", inverse_metric),
        f"Same confirmation gate passed: {'YES' if confirmation else 'NO'}",
        "",
        "FINAL DECISION",
        "--------------",
        (
            "CONFIRMED FOR A FORWARD PAPER-ONLY CANDIDATE. This is still not live-money evidence."
            if confirmation
            else "REJECTED. The DEV leader did not survive untouched HOLDOUT; do not activate or invert it."
        ),
        "",
    ]
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return {
        "gatePassed": True,
        "holdoutOpened": True,
        "holdoutConfirmed": confirmation,
        "selected": state["selected"]["name"],
        "holdoutWinRate": selected_metric["wr"],
        "holdoutWilsonLow": selected_metric["ciLow"],
        "audit": audit,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("discovery", "holdout"), required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    state_path = Path(args.state)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    if args.phase == "discovery":
        status = discovery(payload, state_path, report_path)
    else:
        status = holdout(payload, state_path, report_path)
    Path(args.status).write_text(json.dumps(status, indent=2), encoding="utf-8")
    print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()
