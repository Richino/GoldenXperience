"""Stage 5 — render FINAL_REPORT.md from RESULTS.json."""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def tbl(d: dict, keys=("trades", "win_rate", "avg_pips", "expectancy_R", "profit_factor", "total_pips")):
    head = "| " + " | ".join(keys) + " |"
    sep = "|" + "|".join(["---"] * len(keys)) + "|"
    row = "| " + " | ".join(str(d.get(k, "")) for k in keys) + " |"
    return "\n".join([head, sep, row])


def named_table(mapping: dict, label="bucket"):
    keys = ("trades", "win_rate", "avg_pips", "expectancy_R", "profit_factor")
    lines = ["| " + label + " | " + " | ".join(keys) + " |",
             "|" + "|".join(["---"] * (len(keys) + 1)) + "|"]
    for name, m in mapping.items():
        lines.append("| " + name + " | " + " | ".join(str(m.get(k, "")) for k in keys) + " |")
    return "\n".join(lines)


def main():
    with open(os.path.join(HERE, "RESULTS.json")) as f:
        R = f.read()
    r = json.loads(R)

    v = r["verdict"]
    verdict_line = {
        "PRE_NEWS_EDGE": "**PRE_NEWS_EDGE** — a robust, baseline-beating, positive-PF edge on the historical walk-forward.",
        "PROMISING_BUT_UNPROVEN": "**PROMISING_BUT_UNPROVEN** — positive on the historical walk-forward and ahead of the naive baselines, but not robust/large enough to call a proven edge.",
        "NO_PRE_NEWS_EDGE": "**NO_PRE_NEWS_EDGE** — the model does not produce a positive, baseline-beating edge on the historical walk-forward.",
        "INSUFFICIENT_DATA": "**INSUFFICIENT_DATA** — too few eligible trades to judge.",
    }[v]

    md = []
    md.append("# Pre-News Prediction v1 — USD High-Impact\n")
    md.append(f"_Generated {r['generated_at']}_\n")
    md.append("## Verdict\n")
    md.append(verdict_line + "\n")
    md.append(
        "> The verdict is based on the **historical walk-forward**, not the final 10 days. "
        "Each historical event was predicted only by a model trained on strictly-earlier "
        "events; the final 10 days are a separate untouched demonstration.\n")

    md.append("## What this is\n")
    md.append(
        "A leakage-safe test of whether USD high-impact economic releases can be predicted "
        "**before** the release well enough to trade EUR_USD. Calendar actual/forecast/previous "
        "come from TradingView's economic-calendar API (Forex Factory's exports carry no "
        "historical `actual`); prices are OANDA **bid/ask** M1 candles, so every trade pays real "
        "spread. All features are frozen at **T−10 min** (the earliest tested entry), so no entry "
        "can see post-decision information.\n")

    md.append("## Data\n")
    md.append(
        f"- Rows (USD high-impact, actual+forecast present): **{r['n_rows']}**\n"
        f"- Historical (training/walk-forward): **{r['n_historical']}**\n"
        f"- Final untouched OOS (last {10} days): **{r['n_final10']}**, split at {r['oos_split_date'][:10]}\n"
        f"- Primary config chosen on historical WF: **entry −{r['primary_entry_offset_min']}m, exit {r['primary_exit_rule']}**\n"
        f"- Confidence threshold: {r['conf_threshold']}\n")

    md.append("## Model vs baselines (historical)\n")
    md.append("Baselines A–C are single-rule direction predictors; D is the model on the same "
              "all-tradeable universe (entry −5m, exit T30). The deployed model adds a confidence "
              "filter and the chosen primary config.\n")
    md.append(named_table({
        "A: actual follows previous": r["baselines"]["A_actual_follows_previous"],
        "B: forecast vs previous": r["baselines"]["B_forecast_vs_previous"],
        "C: pre-news trend only": r["baselines"]["C_prenews_trend_only"],
        "D: full model (no conf filter)": r["baselines"]["D_full_model"],
    }, label="baseline"))
    md.append("")
    md.append(f"**Beats naive baselines:** {'yes' if r['beats_baselines'] else 'no'}\n")

    md.append("## Historical walk-forward (verdict basis)\n")
    md.append(tbl(r["historical_walkforward"]))
    md.append("")

    md.append("## Final 10-day OOS demonstration\n")
    md.append(tbl(r["final_10day_oos"]))
    md.append("\n_Recent demo only — not the basis for the verdict._\n")

    md.append("## Results by event\n")
    md.append(named_table(r["by_event"], label="event"))
    md.append("")
    md.append("## Results by confidence bucket\n")
    md.append(named_table(r["by_confidence"], label="confidence"))
    md.append("")
    md.append("## Results by entry timing\n")
    md.append(named_table(r["by_entry_timing"], label="entry"))
    md.append("")
    md.append("## Results by exit horizon\n")
    md.append(named_table(r["by_exit_horizon"], label="exit"))
    md.append("")

    md.append("## Honest caveats\n")
    md.append(
        "- Execution is modelled on EUR_USD M1 OHLC; intrabar SL/TP assumes the stop is touched "
        "first (conservative). Real fills around a release can slip beyond M1 OHLC.\n"
        "- Inflation polarity assumes a hot print is USD-bullish (hawkish channel); regime shifts "
        "can invert this.\n"
        "- One simple model on ~1k rows; treat any positive result as a hypothesis, not proof.\n"
        "- No live orders were placed. Research/paper only.\n")

    with open(os.path.join(HERE, "FINAL_REPORT.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    print("wrote FINAL_REPORT.md; verdict:", v)


if __name__ == "__main__":
    main()
