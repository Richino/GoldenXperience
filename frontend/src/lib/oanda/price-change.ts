/** Display-only change against the last verified completed New York daily close. */
export function dailyPriceChange(price: number, previousDailyClose: number | null) {
  if (!(price > 0) || !Number.isFinite(price) || previousDailyClose === null || !(previousDailyClose > 0) || !Number.isFinite(previousDailyClose)) return null;
  const raw = (price / previousDailyClose - 1) * 100;
  // Round once before choosing the sign, so -0.004% never displays as negative zero.
  return Math.round(raw * 100) / 100 || 0;
}

/** The signed percent alone, for places that already say the change is daily. */
export function dailyChangePercentLabel(change: number | null) {
  return change === null ? "—" : `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)}%`;
}

export function dailyChangeLabel(change: number | null) {
  return change === null ? "Daily —" : `${dailyChangePercentLabel(change)} · Daily`;
}
