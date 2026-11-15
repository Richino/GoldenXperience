import type { MarketPriceTick } from "@/types/market-stream";

const PRICE_ROWS = 32;
const VALUE_AREA = 0.7;

/** Accumulate streaming quotes for one candle, clearing at rollover. */
export class VolumeProfileQuoteBuffer {
  private candleStart = -Infinity;
  private counts = new Map<number, number>();
  private lastTime = "";

  add(tick: MarketPriceTick, candleStart: number, precision: number) {
    const time = Date.parse(tick.time);
    if (tick.source !== "oanda" || !(tick.mid > 0) || !Number.isFinite(tick.mid) ||
        !Number.isFinite(candleStart) || candleStart < this.candleStart || !Number.isFinite(time) ||
        tick.time === this.lastTime || time < Date.parse(this.lastTime)) return false;
    if (candleStart !== this.candleStart) {
      this.candleStart = candleStart;
      this.counts.clear();
    }
    this.lastTime = tick.time;
    const price = Number(tick.mid.toFixed(precision));
    this.counts.set(price, (this.counts.get(price) ?? 0) + 1);
    return true;
  }

  snapshot() {
    return { candleStart: this.candleStart, profile: calculateVolumeProfile(this.counts) };
  }
}

export type LiveVolumeProfile = {
  candleEnd: number;
  profile: ReturnType<typeof calculateVolumeProfile>;
};

/** Whole adjacent price rows make up the value area. */
export function calculateVolumeProfile(counts: ReadonlyMap<number, number>) {
  if (!counts.size) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const price of counts.keys()) {
    low = Math.min(low, price);
    high = Math.max(high, price);
  }

  const count = high === low ? 1 : PRICE_ROWS;
  const step = (high - low) / count;
  const rows = Array.from({ length: count }, (_, i) => ({
    low: low + i * step,
    high: i === count - 1 ? high : low + (i + 1) * step,
    volume: 0,
  }));
  for (const [price, volume] of counts) {
    const index = step === 0 ? 0 : Math.min(count - 1, Math.floor((price - low) / step));
    rows[index].volume += volume;
  }

  let total = 0;
  let poc = 0;
  for (let i = 0; i < count; i += 1) {
    total += rows[i].volume;
    if (rows[i].volume > rows[poc].volume) poc = i;
  }

  let first = poc;
  let last = poc;
  let included = rows[poc].volume;
  while (included < VALUE_AREA * total && (first > 0 || last < count - 1)) {
    const below = rows[first - 1]?.volume ?? -1;
    const above = rows[last + 1]?.volume ?? -1;
    if (above >= below) included += rows[++last].volume;
    else included += rows[--first].volume;
  }

  return {
    quoteCount: total,
    rows,
    poc,
    pocPrice: (rows[poc].low + rows[poc].high) / 2,
    valueArea: { first, last, low: rows[first].low, high: rows[last].high },
  };
}
