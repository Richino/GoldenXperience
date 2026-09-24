export function pairLabel(instrument: string) {
  return instrument.replace('_', '/');
}

export function formatPrice(value: number, instrument: string) {
  const decimals = instrument.includes('JPY') ? 3 : 5;
  return value.toFixed(decimals);
}

export function moneyLabel(value: number | null, currency: string) {
  if (value === null) return '—';
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Math.abs(value));
  if (Math.abs(value) < 0.005) return formatted;
  return `${value > 0 ? '+' : '−'}${formatted}`;
}

export function rLabel(value: number | null) {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}R`;
}
