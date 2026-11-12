import { currenciesOf } from "@/lib/instruments/catalog";
import type { HomeCurrencyConversion } from "@/types/forex";

type Fill = { price: number; units: number };
const validPrice = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function chartTradePLColor(amount: number | null) {
  return amount === null || Math.abs(amount) < 0.005 ? "#8b9280" : amount > 0 ? "#00b377" : "#e74c3c";
}

/** Project P/L on the remaining units using the broker's current gain or loss rate. */
export function chartTargetPL(fill: Fill | undefined, instrument: string, direction: "long" | "short" | null, currency: string | null, target: number | null, conversion?: HomeCurrencyConversion) {
  if (!fill || !direction || !currency || !validPrice(target) || !validPrice(fill.price) || !Number.isFinite(fill.units) || fill.units <= 0) return null;
  const side = direction === "long" ? 1 : -1;
  const quoteProfit = side * (target - fill.price) * fill.units;
  if (quoteProfit === 0) return 0;
  if (currenciesOf(instrument).quote === currency) return quoteProfit;
  const rate = quoteProfit > 0 ? conversion?.gain : conversion?.loss;
  return validPrice(rate) ? quoteProfit * rate : null;
}
