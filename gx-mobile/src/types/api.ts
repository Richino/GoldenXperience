export type AccountSummary = {
  id: string;
  alias: string;
  currency: string;
  balance: number;
  nav: number;
  unrealizedPL: number;
  marginUsed: number;
  marginAvailable: number;
  openTradeCount: number;
  hedgingEnabled: boolean;
  source: string;
};

export type AccountBalanceHistoryPoint = {
  id: string;
  time: string;
  balance: number;
  change: number;
  type: string;
};

/** A broker-marked position for Home's live Open Positions section. */
export type OpenPosition = {
  id: string;
  instrument: string;
  pair: string;
  direction: 'long' | 'short';
  units: number;
  entryPrice: number;
  stopPrice: number | null;
  currentPrice: number;
  unrealizedPL: number;
  openedAt: string;
};

export type JournalTrade = {
  id: string;
  origin: 'demo' | 'manual' | 'strategy';
  chartTradeId: string | null;
  pair: string;
  instrument: string | null;
  direction: 'long' | 'short';
  status: 'open' | 'closed';
  result: 'win' | 'loss' | 'breakeven' | 'open';
  outcome: string | null;
  openedAt: string;
  closedAt: string | null;
  entry: number;
  stop: number;
  target: number;
  exit: number | null;
  resultR: number | null;
  paperPl: number | null;
  brokerExecutionStatus: string | null;
  /**
   * Broker-history-synced closes (`syncPracticeBrokerHistory`, api-server)
   * never populate `paperPl` — the realized amount only ever lands in this
   * free-text note ("Broker realized P&L: 154.10 USD."). See
   * `parseBrokerRealizedPl` in lib/home/activity.ts.
   */
  notes: string | null;
  reason?: string | null;
  nominalRiskAmount?: number | null;
  strategyFamily?: string | null;
};

export type PendingEntry = {
  id: string;
  instrument: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryOrderType: string;
  expiresAt: string | null;
  invalidationPrice: number | null;
  status: 'PENDING' | 'TRIGGERING' | 'CANCELLED' | 'TRIGGERED' | 'EXPIRED' | 'FAILED';
};

export type CalendarEvent = {
  id: string;
  title: string;
  currency: string;
  impact: number;
  timestamp: string;
};

export type CalendarSnapshot = {
  connected: boolean;
  events: CalendarEvent[];
  warnings: Array<{ tone: 'success' | 'warning' | 'danger'; message: string }>;
};

export type AppNotification = {
  id: string;
  kind: 'setup_ready' | 'paper_opened' | 'paper_closed' | 'trade_update' | 'system_issue';
  title: string;
  message: string;
  instrument: string | null;
  paperTradeId: string | null;
  readAt: string | null;
  createdAt: string;
};

export type PaperRiskConfiguration = {
  riskPercent: number;
  maxSimultaneousPositions: number | null;
  maxTotalNominalRiskPercent: number | null;
};

export type PaperRiskPolicy = {
  active: PaperRiskConfiguration;
  pending: PaperRiskConfiguration | null;
  collectionPaused: boolean;
  pendingAppliesTo: 'next_batch' | null;
  currentBatch: { batchNumber: number; assignedCount: number } | null;
  applied?: 'immediately' | 'next_batch';
};
