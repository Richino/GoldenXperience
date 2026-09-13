export type PendingManualEntryStatus =
  | "PENDING"
  | "TRIGGERING"
  | "TRIGGERED"
  | "EXPIRED"
  | "INVALIDATED"
  | "CANCELLED"
  | "FAILED";

export interface PendingManualEntry {
  id: string;
  instrument: string;
  direction: "long" | "short";
  entryPrice: number;
  entryOrderType: "buy_stop" | "buy_limit" | "sell_stop" | "sell_limit";
  currentPriceAtCreation: number;
  expirationType: "none" | "time";
  expiresAt: string | null;
  invalidationPrice: number | null;
  status: PendingManualEntryStatus;
  triggerPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  paperTradeId: string | null;
  failureReason: string | null;
  triggeredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

