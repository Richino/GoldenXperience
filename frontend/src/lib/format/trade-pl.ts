/** Broker P/L is already in account currency; never label it as quote cash. */
export function formatTradePL(amount: number | null | undefined, currency: string | null): string {
  if (typeof amount !== "number" || !Number.isFinite(amount) || !currency) return "P/L —";
  // A sub-cent loss must not appear as negative zero.
  const value = Math.abs(amount) < 0.005 ? 0 : amount;
  try {
    const money = new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Math.abs(value));
    return `P/L ${value > 0 ? "+" : value < 0 ? "−" : ""}${money}`;
  } catch {
    return "P/L —";
  }
}
