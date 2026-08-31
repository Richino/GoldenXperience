/**
 * eurusd-exogenous-v1 — exogenous feature families (all causal at time t).
 *
 * Families are kept separable so we can run grouped ablations (§12) and never
 * let 20 correlated variables manufacture confidence (§21):
 *   DXY    : synthetic USD strength basket ("DXY-ex-EUR"), EUR excluded.
 *   XFX    : EUR strength basket + strength_diff + individual lead pairs.
 *   RISK   : gold.
 * Feature sign convention is raw (logistic learns the sign); e.g. usd_ret is
 * positive when USD strengthened, which the hypothesis says is EUR/USD-bearish.
 */
import { type ExoStore } from "./exo-data.js";

export const DXY_FEATURES = ["usd_ret_1", "usd_ret_2", "usd_ret_4", "usd_ret_8", "usd_ret_24", "usd_accel", "usd_slope"];
export const XFX_FEATURES = ["eur_ret_1", "eur_ret_4", "eur_ret_24", "sdiff_1", "sdiff_4", "sdiff_24", "usdjpy_ret_4", "gbpusd_ret_4", "eurgbp_ret_4", "eurjpy_ret_4"];
export const RISK_FEATURES = ["gold_ret_1", "gold_ret_4", "gold_ret_24"];

/** USD strength basket return over k hours (EUR excluded). + = USD strengthened. */
export function usdStrength(exo: ExoStore, t: number, k: number): number {
  return (
    exo.ret("USD_JPY", t, k) + exo.ret("USD_CHF", t, k) + exo.ret("USD_CAD", t, k)
    - exo.ret("GBP_USD", t, k) - exo.ret("AUD_USD", t, k) - exo.ret("NZD_USD", t, k)
  ) / 6;
}
/** EUR strength basket return over k hours (USD excluded). + = EUR strengthened. */
export function eurStrength(exo: ExoStore, t: number, k: number): number {
  return (exo.ret("EUR_GBP", t, k) + exo.ret("EUR_JPY", t, k)) / 2;
}

export function buildExoFeatures(exo: ExoStore, t: number): Record<string, number> {
  const usd = (k: number) => usdStrength(exo, t, k);
  const eur = (k: number) => eurStrength(exo, t, k);
  return {
    // DXY / USD basket
    usd_ret_1: usd(1), usd_ret_2: usd(2), usd_ret_4: usd(4), usd_ret_8: usd(8), usd_ret_24: usd(24),
    usd_accel: usd(1) - (usd(2) - usd(1)),           // recent vs prior hour
    usd_slope: usd(4) / 4,
    // cross-FX
    eur_ret_1: eur(1), eur_ret_4: eur(4), eur_ret_24: eur(24),
    sdiff_1: eur(1) - usd(1), sdiff_4: eur(4) - usd(4), sdiff_24: eur(24) - usd(24),
    usdjpy_ret_4: exo.ret("USD_JPY", t, 4), gbpusd_ret_4: exo.ret("GBP_USD", t, 4),
    eurgbp_ret_4: exo.ret("EUR_GBP", t, 4), eurjpy_ret_4: exo.ret("EUR_JPY", t, 4),
    // risk
    gold_ret_1: exo.ret("XAU_USD", t, 1), gold_ret_4: exo.ret("XAU_USD", t, 4), gold_ret_24: exo.ret("XAU_USD", t, 24),
  };
}

export const FAMILIES: Record<string, string[]> = {
  DXY: DXY_FEATURES,
  XFX: XFX_FEATURES,
  RISK: RISK_FEATURES,
  "DXY+XFX": [...DXY_FEATURES, ...XFX_FEATURES],
  "ALL_EXO": [...DXY_FEATURES, ...XFX_FEATURES, ...RISK_FEATURES],
};
