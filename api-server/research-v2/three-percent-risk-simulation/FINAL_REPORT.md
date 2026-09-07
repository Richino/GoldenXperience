# Three-percent risk simulation

$100 starting equity; current exits; historical executable costs.

| Pair, original window | Trades | Ending balance | Sampled equity drawdown | Lowest equity |
|---|---:|---:|---:|---:|
| EUR_USD | 356 | $171.30 | 38.1% | $80.80 |
| USD_JPY | 67 | $136.04 | 21.3% | $93.49 |
| GBP_USD | 79 | $127.74 | 25.0% | $93.65 |
| AUD_USD | 195 | $174.67 | 31.7% | $87.77 |

Combined common window: 2025-01-06T00:00:00.000Z to 2026-09-01T00:00:00.000Z. All-fill model: $296.88, 40.3% drawdown, minimum $93.73; 4 simultaneous positions; maximum committed stop risk 11.9% of equity. 51 entries exceed estimated available margin.

Margin-feasibility approximation: $179.64, 37.1% drawdown; 299 filled, 45 margin-rejected candidates; margin-closeout samples 0.

Rolling window summary:

- 11 months, all fills: 10 overlapping windows; ending balance $132.49–$268.42; worst sampled drawdown 40.3%; $7000 reached in 0 windows.
- 11 months, margin constrained: 10 overlapping windows; ending balance $96.23–$202.91; worst sampled drawdown 37.1%; $7000 reached in 0 windows.
- 12 months, all fills: 9 overlapping windows; ending balance $144.61–$325.29; worst sampled drawdown 40.3%; $7000 reached in 0 windows.
- 12 months, margin constrained: 9 overlapping windows; ending balance $101.60–$245.88; worst sampled drawdown 37.1%; $7000 reached in 0 windows.

- Margin metadata status: UNAVAILABLE_HTTP_503; ILLUSTRATIVE_50_TO_1_AND_WHOLE_UNITS. If unavailable, the margin-constrained result is explicitly a hypothetical 50:1 leverage scenario, not a claim about the user's account or historical OANDA requirements.
- $100 initial equity, 3% pre-entry equity stop risk per trade; current frozen exits and recorded executable R results, no new signals or exit variants.
- Equity for sizing includes unrealized P&L at the latest completed executable candle close. Same-timestamp exits settle before entries; entries share a pre-entry equity snapshot. Correlated chronological outcomes and overlapping positions are retained.
- Two models: unconstrained fills of every saved signal, and a margin-feasibility approximation using instrument margin rates and unit precision where available, otherwise the explicitly stated hypothetical 50:1/whole-unit scenario. Fixed pair order allocates simultaneous margin. A rejected candidate is skipped, never delayed or resized except rounding down to allowed unit precision.
- Margin and conversion calculations are estimates: current instrument rates are applied throughout history; USDJPY risk dollars are converted at entry and saved R determines realized P&L. Account-specific rate overrides, historical rate changes, currency-conversion charges, financing, latency, gap slippage and netting details are not fully modeled.
- Margin closeout samples flag equity at/below half estimated margin, not a full broker liquidation simulation. Drawdown is sampled at completed H1/M30 closes plus entry/exit events, not tick-level worst drawdown. Real intrabar losses may be larger.
- The combined portfolio uses only the common available period, avoiding an artificial GBPUSD absence before its saved window. Rolling 11/12-month windows overlap and are descriptive, not independent trials or probabilities.
- Window entries are admitted by entry time only. Trades still open at a window boundary are marked to the latest available completed quote; their later recorded outcome is not used. Ending balance in these tables denotes ending equity, including any unrealized P&L.
- Recorded EURUSD/GBPUSD executable targets can pay below +2R; USDJPY/AUDUSD target +2R. Existing Pine-parity and historical-sample limitations carry forward. Risk-only percentage sizing generally cannot hit exactly zero with bounded stops, so ending above zero is not evidence of safety.
