import {
  STREAM_INSTRUMENTS,
  type MajorInstrument,
  type MarketPriceTick,
} from "./market-stream-types.js";
import { formatInstrument } from "./market-stream-normalize.js";

const precision: Record<MajorInstrument, number> = {
  EUR_USD: 5,
  GBP_USD: 5,
  USD_JPY: 3,
  AUD_USD: 5,
  NZD_USD: 5,
  USD_CAD: 5,
  USD_CHF: 5,
  EUR_GBP: 5,
  EUR_JPY: 3,
  GBP_JPY: 3,
  AUD_JPY: 3,
  EUR_AUD: 5,
};

const prices: Record<MajorInstrument, number> = {
  EUR_USD: 1.08972,
  GBP_USD: 1.27345,
  USD_JPY: 156.782,
  AUD_USD: 0.65123,
  NZD_USD: 0.60234,
  USD_CAD: 1.37234,
  USD_CHF: 0.89234,
  EUR_GBP: 0.85234,
  EUR_JPY: 168.234,
  GBP_JPY: 197.456,
  AUD_JPY: 99.850,
  EUR_AUD: 1.62340,
};

export function createMockTick(
  instrument: MajorInstrument,
  sequence: number,
): MarketPriceTick {
  const jpyQuoted = instrument.endsWith("_JPY");
  const scale = jpyQuoted ? 0.012 : 0.00008;
  const spread = jpyQuoted ? 0.014 : 0.00008;
  const wave = Math.sin(sequence * 0.55 + instrument.length) * scale;
  const drift = (Math.random() - 0.5) * scale * 0.55;
  const next = prices[instrument] + wave + drift;
  const decimals = precision[instrument];

  prices[instrument] = Number(next.toFixed(decimals));

  const bid = Number((prices[instrument] - spread / 2).toFixed(decimals));
  const ask = Number((prices[instrument] + spread / 2).toFixed(decimals));

  return {
    type: "price",
    instrument,
    displayName: formatInstrument(instrument),
    bid,
    ask,
    mid: Number(((bid + ask) / 2).toFixed(decimals)),
    spread: Number((ask - bid).toFixed(decimals)),
    status: "tradeable",
    time: new Date().toISOString(),
    source: "mock",
    sequence,
  };
}

export function getDefaultMockInstruments() {
  return [...STREAM_INSTRUMENTS];
}

