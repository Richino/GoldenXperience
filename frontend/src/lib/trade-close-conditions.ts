export interface CashCloseAmounts {
  profitAmount: number | null;
  lossAmount: number | null;
}

export interface CashCloseConditions extends CashCloseAmounts {
  version: 1;
  currency: string;
  accountKey: string;
  brokerTradeId: string;
  state: "armed" | "closing" | "closed";
  trigger: "profit" | "loss" | null;
  triggeredPL: number | null;
  triggeredAt: string | null;
  lastCheckedAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
}

/** Both fields are positive cash magnitudes; the loss comparison supplies −. */
export function parseCashCloseAmounts(raw: Record<string, unknown>): CashCloseAmounts {
  const read = (value: unknown, label: string) => {
    if (value === null || value === "") return null;
    if (typeof value !== "number" && typeof value !== "string") throw new Error(`Enter a positive ${label} amount, or leave it blank.`);
    if (typeof value === "string" && !/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error(`Enter a positive ${label} amount with up to 2 decimal places.`);
    const amount = Number(value);
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 0.000001) {
      throw new Error(`Enter a positive ${label} amount with up to 2 decimal places.`);
    }
    return cents / 100;
  };
  return { profitAmount: read(raw.profitAmount, "profit"), lossAmount: read(raw.lossAmount, "loss") };
}

export function cashCloseTrigger(limits: CashCloseAmounts, unrealizedPL: number | null): "profit" | "loss" | null {
  if (unrealizedPL === null || !Number.isFinite(unrealizedPL)) return null;
  if (limits.profitAmount !== null && unrealizedPL >= limits.profitAmount) return "profit";
  if (limits.lossAmount !== null && unrealizedPL <= -limits.lossAmount) return "loss";
  return null;
}

export function readCashCloseConditions(value: unknown): CashCloseConditions | null {
  if (!value || typeof value !== "object") return null;
  const rules = value as CashCloseConditions;
  if (rules.version !== 1 || !["armed", "closing", "closed"].includes(rules.state)
    || typeof rules.accountKey !== "string" || !rules.accountKey || typeof rules.brokerTradeId !== "string" || !rules.brokerTradeId
    || typeof rules.currency !== "string" || !/^[A-Z]{3}$/.test(rules.currency)) return null;
  try {
    const amounts = parseCashCloseAmounts({ profitAmount: rules.profitAmount, lossAmount: rules.lossAmount });
    if (amounts.profitAmount === null && amounts.lossAmount === null) return null;
  } catch { return null; }
  return rules;
}
