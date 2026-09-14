export type NotificationKind = "setup_ready" | "paper_opened" | "paper_closed" | "trade_update" | "system_issue";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  instrument: string | null;
  paperTradeId: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationToast = AppNotification & { preview?: boolean };
