/**
 * Centralised financial formatting (brief §15). One home for money, signed
 * money, R multiples, percentages and the trading-zone clock so every screen
 * reads figures identically. Forex prices are handled in `instruments.ts`,
 * which respects per-instrument precision.
 */

const TRADING_TIME_ZONE = "America/New_York";

/** $82,167.10 */
export function formatMoney(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

/** +$116.42 / -$30.20 — always sign-prefixed for P/L. */
export function formatSignedMoney(value: number, currency = "USD"): string {
  const formatted = formatMoney(Math.abs(value), currency);
  return `${value >= 0 ? "+" : "-"}${formatted}`;
}

/** +1.24R / -0.32R */
export function formatR(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}R`;
}

/** 1:2 / 1:1.5 — a risk:reward ratio. */
export function formatRatio(riskReward: number | null): string {
  if (riskReward === null || !Number.isFinite(riskReward)) return "—";
  const rounded = Math.round(riskReward * 10) / 10;
  return `1:${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}`;
}

/** 62.5% */
export function formatPercent(fraction: number | null, digits = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** A short "12m ago" relative label, or "" when the timestamp is missing. */
export function relativeTime(at: string | null, now = Date.now()): string {
  if (!at) return "";
  const minutes = Math.round((now - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "Aug 6, 1:00 PM" in the trading zone (matches the web journal). */
export function formatDayAndTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TRADING_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).format(new Date(value));
}

/** "2026-08-06" — the trading-zone calendar day, for "closed today" checks. */
export function tradingDayKey(value: string | number | Date = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TRADING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
