import type { MajorInstrument, MarketPriceTick } from "./market-stream-types.js";
import { displayNameFor, isKnownInstrument } from "../../frontend/src/lib/instruments/catalog.js";

interface OandaPriceBucket {
  price: string;
}

export interface OandaStreamPrice {
  type?: "PRICE";
  instrument?: string;
  time?: string;
  status?: string;
  closeoutBid?: string;
  closeoutAsk?: string;
  bids?: OandaPriceBucket[];
  asks?: OandaPriceBucket[];
}

export function formatInstrument(instrument: MajorInstrument) {
  return displayNameFor(instrument);
}

export function normalizeOandaPrice(
  price: OandaStreamPrice,
  sequence: number,
): MarketPriceTick | null {
  if (!price.instrument || !isKnownInstrument(price.instrument)) return null;

  const instrument = price.instrument as MajorInstrument;
  const bid = Number(price.bids?.[0]?.price ?? price.closeoutBid);
  const ask = Number(price.asks?.[0]?.price ?? price.closeoutAsk);

  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;

  return {
    type: "price",
    instrument,
    displayName: formatInstrument(instrument),
    bid,
    ask,
    mid: (bid + ask) / 2,
    spread: ask - bid,
    status: (price.status ?? "unknown").toLowerCase(),
    time: price.time ?? new Date().toISOString(),
    source: "oanda",
    sequence,
  };
}


