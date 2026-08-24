import type { FeatureFamily } from "../types.js";
import { crossPairFeatures, crossSectionalRank, currencyStrength } from "./cross-pair.js";
import { eventFeatures, macroFeatures } from "./macro-events.js";
import { priceFeatures } from "./price.js";
import { regimeFeatures } from "../regimes.js";
import { sessionOneHot } from "../sessions.js";
import type { Candle, RegimeSnapshot } from "../types.js";

export type CrossContext = {
  pairReturns1: Record<string, number>;
  pairReturns12: Record<string, number>;
};

export function buildFeatureVector(args: {
  instrument: string;
  candles: Candle[];
  index: number;
  regime: RegimeSnapshot;
  families: FeatureFamily[];
  cross?: CrossContext;
}): { features: Record<string, number>; names: string[] } {
  const { instrument, candles, index, regime, families, cross } = args;
  let features: Record<string, number> = {};

  if (families.includes("price")) {
    features = { ...features, ...priceFeatures(candles, index) };
  }
  if (families.includes("regime")) {
    features = { ...features, ...regimeFeatures(regime) };
  }
  if (families.includes("session")) {
    features = { ...features, ...sessionOneHot(regime.session) };
  }
  if (families.includes("cross_pair") && cross) {
    const s1 = currencyStrength(cross.pairReturns1);
    const s12 = currencyStrength(cross.pairReturns12);
    const xp = crossPairFeatures(instrument, cross.pairReturns1, cross.pairReturns12, s1, s12);
    xp.xs_mom_rank = crossSectionalRank(instrument, cross.pairReturns12);
    features = { ...features, ...xp };
  }
  if (families.includes("events")) {
    features = { ...features, ...eventFeatures(instrument, candles[index]!.closeTime) };
  }
  if (families.includes("macro")) {
    features = { ...features, ...macroFeatures(instrument, candles[index]!.closeTime) };
  }

  // Vol × JPY interaction channels (when both families present)
  if (families.includes("cross_pair") && families.includes("regime")) {
    const jpy = features.jpy_str_12 ?? 0;
    features.jpy_x_vol_exp = jpy * (features.reg_phase_exp ?? 0);
    features.jpy_x_vol_high = jpy * (features.reg_vol_high ?? 0);
    features.usd_jpy_x_vol_exp = (features.usd_minus_jpy_12 ?? 0) * (features.reg_phase_exp ?? 0);
  }

  const names = Object.keys(features).sort();
  return { features, names };
}
