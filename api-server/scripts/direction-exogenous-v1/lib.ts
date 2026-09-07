/**
 * DIRECTION_EXOGENOUS_V1 — exogenous-lane library (CROSS_FX lane).
 *
 * Read-only w.r.t. the frozen MOVE_MODEL, DIRECTION_MODEL and diagnosis. Reuses
 * their loaders/feature/label pipeline unchanged. Adds only causal CROSS-FX
 * relative-strength features (other currency pairs + gold) — the one genuinely
 * exogenous data lane that exists LOCALLY. All other lanes (rates, central-bank,
 * positioning, order-flow, options) have no local data and are declared
 * INSUFFICIENT_DATA by the experiment rather than proxied.
 *
 * Causality: every cross feature at prediction time T uses only cross-pair bars
 * completed at or before T (last bar with timestamp <= T), predicting EUR/USD
 * direction over T -> T+H. No contemporaneous or future cross bar is used.
 */
import { loadBars, type Bar } from "../direction-model-v1/lib.js";

export type Ser = { t: number[]; logc: number[] };
function toSer(bars: Bar[]): Ser { return { t: bars.map((b) => b.t), logc: bars.map((b) => Math.log(b.close)) }; }
function idxAtOrBefore(ts: number[], t: number) { let l = 0, h = ts.length; while (l < h) { const m = (l + h) >>> 1; ts[m]! <= t ? l = m + 1 : h = m; } return l - 1; }
function ret(s: Ser, i: number, lag: number) { return i >= lag ? s.logc[i]! - s.logc[i - lag]! : 0; }

export const CROSS_PAIRS = ["GBP_USD", "USD_JPY", "USD_CHF", "USD_CAD", "AUD_USD", "NZD_USD", "EUR_GBP", "EUR_JPY", "XAU_USD"] as const;
export function loadCrossSeries(): Record<string, Ser> {
  const out: Record<string, Ser> = {};
  for (const p of CROSS_PAIRS) out[p] = toSer(loadBars(`backtest-legacy-expanded/candles/${p}_M15.json`));
  out["EUR_USD"] = toSer(loadBars("backtest-legacy-expanded/candles/EUR_USD_M15.json"));
  return out;
}

// USD legs: for X_USD pairs USD is the quote (USD strengthens when pair falls => sign -1);
// for USD_X pairs USD is the base (strengthens when pair rises => +1).
const USD_LEGS: Array<[string, number]> = [["GBP_USD", -1], ["AUD_USD", -1], ["NZD_USD", -1], ["USD_JPY", 1], ["USD_CHF", 1], ["USD_CAD", 1]];
// EUR legs: pairs where EUR is the base (+1) — excludes EUR_USD so the feature is EXOGENOUS to EUR/USD's own price.
const EUR_LEGS: Array<[string, number]> = [["EUR_GBP", 1], ["EUR_JPY", 1]];

export const CROSS_FEATURES: Array<{ name: string; group: string }> = [
  { name: "usd_str_1", group: "basket" }, { name: "usd_str_4", group: "basket" }, { name: "usd_str_16", group: "basket" }, { name: "usd_str_48", group: "basket" },
  { name: "eur_str_1", group: "basket" }, { name: "eur_str_4", group: "basket" }, { name: "eur_str_16", group: "basket" }, { name: "eur_str_48", group: "basket" },
  { name: "eur_minus_usd_4", group: "basket" }, { name: "eur_minus_usd_16", group: "basket" }, { name: "eur_minus_usd_48", group: "basket" },
  { name: "basket_divergence_4", group: "divergence" }, { name: "basket_divergence_16", group: "divergence" }, // (eur-usd implied) - actual EURUSD return: lead/lag
  { name: "gbpusd_4", group: "specific" }, { name: "usdjpy_4", group: "specific" }, { name: "eurgbp_4", group: "specific" }, { name: "eurjpy_4", group: "specific" }, { name: "usdchf_4", group: "specific" },
  { name: "gold_4", group: "gold" }, { name: "gold_16", group: "gold" },
];
export const CROSS_GROUPS = [...new Set(CROSS_FEATURES.map((f) => f.group))];

/** Build the causal cross-FX feature vector at time t. Returns null if any pair lacks recent data. */
export function crossFeaturesAt(ser: Record<string, Ser>, t: number, barMs: number): number[] | null {
  const idx: Record<string, number> = {};
  for (const p of Object.keys(ser)) { const i = idxAtOrBefore(ser[p]!.t, t); if (i < 48 || t - ser[p]!.t[i]! > 2 * barMs) return null; idx[p] = i; }
  const usdStr = (k: number) => USD_LEGS.reduce((a, [p, s]) => a + s * ret(ser[p]!, idx[p]!, k), 0) / USD_LEGS.length;
  const eurStr = (k: number) => EUR_LEGS.reduce((a, [p, s]) => a + s * ret(ser[p]!, idx[p]!, k), 0) / EUR_LEGS.length;
  const eurusd = (k: number) => ret(ser["EUR_USD"]!, idx["EUR_USD"]!, k);
  const sp = (p: string, k: number) => ret(ser[p]!, idx[p]!, k);
  const scale = 100; // scale tiny log-returns for numerical comfort (models are scale-robust anyway)
  const feats = [
    usdStr(1), usdStr(4), usdStr(16), usdStr(48),
    eurStr(1), eurStr(4), eurStr(16), eurStr(48),
    eurStr(4) - usdStr(4), eurStr(16) - usdStr(16), eurStr(48) - usdStr(48),
    (eurStr(4) - usdStr(4)) - eurusd(4), (eurStr(16) - usdStr(16)) - eurusd(16),
    sp("GBP_USD", 4), sp("USD_JPY", 4), sp("EUR_GBP", 4), sp("EUR_JPY", 4), sp("USD_CHF", 4),
    sp("XAU_USD", 4), sp("XAU_USD", 16),
  ].map((v) => v * scale);
  return feats.every(Number.isFinite) ? feats : null;
}
