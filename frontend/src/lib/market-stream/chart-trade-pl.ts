import { currenciesOf } from "@/lib/instruments/catalog";

type Quote = { bid: number; ask: number };
type Fill = { price: number; units: number; currentBid: number | null; currentAsk: number | null; unrealizedPL: number };
const validPrice = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Tick estimate anchored to the exact trade's account-currency broker snapshot.
 * Cross-currency conversion is held at the broker snapshot rate until its next poll. */
export function chartTradePL(fill: Fill | undefined, instrument: string, direction: "long" | "short" | null, currency: string | null, quote: Quote | null) {
  if (!fill || !Number.isFinite(fill.unrealizedPL)) return null;
  const fallback = fill.unrealizedPL;
  if (!currency || !direction || !quote || !validPrice(fill.price) || !Number.isFinite(fill.units) || fill.units <= 0) return fallback;
  if (!validPrice(quote.bid) || !validPrice(quote.ask) || quote.bid > quote.ask) return fallback;
  const current = direction === "long" ? quote.bid : quote.ask;
  const baseline = direction === "long" ? fill.currentBid : fill.currentAsk;
  if (!validPrice(baseline)) return fallback;
  const side = direction === "long" ? 1 : -1;
  const { base, quote: quoteCurrency } = currenciesOf(instrument);
  let delta: number;
  if (quoteCurrency === currency) {
    delta = side * (current - baseline) * fill.units;
  } else if (base === currency) {
    // Conversion itself moves with the pair when the account owns its base currency.
    delta = side * fill.units * ((current - fill.price) / current - (baseline - fill.price) / baseline);
  } else {
    const baselineQuotePL = side * (baseline - fill.price) * fill.units;
    const conversion = baselineQuotePL === 0 ? null : fallback / baselineQuotePL;
    if (conversion === null || !Number.isFinite(conversion) || conversion <= 0) return fallback;
    delta = side * (current - baseline) * fill.units * conversion;
  }
  const amount = fallback + delta;
  return Number.isFinite(amount) ? amount : fallback;
}

export function chartTradePLColor(amount: number | null) {
  return amount === null || Math.abs(amount) < 0.005 ? "#8b9280" : amount > 0 ? "#00b377" : "#e74c3c";
}

/** Estimated total trade profit at the target, using the broker's actual fill and remaining size. */
export function chartTargetPL(fill: Fill | undefined, instrument: string, direction: "long" | "short" | null, currency: string | null, target: number | null) {
  if (!fill || !direction || !currency || !validPrice(target) || !validPrice(fill.price) || !Number.isFinite(fill.units) || fill.units <= 0) return null;
  const side = direction === "long" ? 1 : -1;
  const quoteProfit = side * (target - fill.price) * fill.units;
  const { base, quote: quoteCurrency } = currenciesOf(instrument);
  if (quoteCurrency === currency) return quoteProfit;
  if (base === currency) return quoteProfit / target;
  const baseline = direction === "long" ? fill.currentBid : fill.currentAsk;
  if (!validPrice(baseline) || !Number.isFinite(fill.unrealizedPL)) return null;
  const baselineQuotePL = side * (baseline - fill.price) * fill.units;
  const conversion = baselineQuotePL === 0 ? null : fill.unrealizedPL / baselineQuotePL;
  return conversion !== null && Number.isFinite(conversion) && conversion > 0 ? quoteProfit * conversion : null;
}
