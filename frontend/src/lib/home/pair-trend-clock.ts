import { candleAligned, candleEnd, intervalTraded } from "../strategy/candle-clock";

const HOUR_MS = 3_600_000;
// Allow the broker time to publish the completed candle.
const PUBLICATION_DELAY_MS = 2 * 60_000;

export function pairTrendSnapshotIsCurrent(checkedAt: string, now = Date.now()): boolean {
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(checked) || checked > now) return false;

  const publishedThrough = now - PUBLICATION_DELAY_MS;
  // The last four days cover a closed forex weekend. Include the opening
  // hour of any candle that straddles the snapshot timestamp.
  const earliest = Math.max(checked - 6 * HOUR_MS, publishedThrough - 96 * HOUR_MS);
  for (let open = Math.floor(earliest / HOUR_MS) * HOUR_MS; open < publishedThrough; open += HOUR_MS) {
    if (!candleAligned(open, "H4")) continue;
    const close = candleEnd(open, "H4");
    if (close + PUBLICATION_DELAY_MS > checked && close <= publishedThrough && intervalTraded(open, close)) return false;
  }
  return true;
}
