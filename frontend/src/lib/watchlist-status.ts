export type WatchlistCondition = {
  name: string;
  passed: boolean;
  required?: boolean;
};

export type WatchlistStatusInput = {
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  direction: "long" | "short" | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  conditions?: WatchlistCondition[];
  openTradeId: string | null;
  tradeSequence: string | null;
};

export type WatchlistCardStatus = {
  label: string;
  tone: string;
  state: "open" | "unavailable" | "ready" | "developing" | "idle";
  progress: number;
  hasLevels: boolean;
};

function hasLevels(row: WatchlistStatusInput) {
  return Boolean(
    row.direction
      && row.entry !== null
      && row.stop !== null
      && row.target !== null,
  );
}

/** Include the full setup sequence so progress cannot reach 100% before a plan exists. */
export function watchlistProgress(row: WatchlistStatusInput) {
  if (row.openTradeId || (row.setupStatus === "valid" && hasLevels(row))) return 100;
  const conditions = row.conditions ?? [];
  if (!conditions.length) return 0;
  return Math.round(
    (conditions.filter((condition) => condition.passed).length / conditions.length) * 100,
  );
}

function blockerLabel(name: string) {
  const labels: Record<string, string> = {
    Session: "outside its trading session",
    Spread: "trading costs are too high",
    News: "major news nearby",
    "Liquidity sweep": "waiting for price movement",
    Location: "waiting for price to reach a level",
    "Rejection or displacement": "waiting for price confirmation",
    "Structure break": "waiting for a price break",
    Macro: "waiting for market confirmation",
    Retest: "waiting for a retest",
    "Setup score": "waiting for a stronger setup",
    "Strategy signal qualified": "waiting for a qualifying setup",
    "Frozen entry rules": "waiting for a qualifying setup",
    "No duplicate signal": "this setup was already used",
    "No active pair position": "a trade is already open for this pair",
    "Stretched from mean": "waiting for a better price",
    "Strong consensus": "waiting for a clearer signal",
    "London window": "waiting for its scheduled check",
    "Enabled leg": "waiting for its scheduled check",
    Origin: "waiting for its scheduled check",
    "EMA20 above EMA50": "waiting for a clearer market trend",
    "EMA alignment": "waiting for a clearer market trend",
    "EMA trend": "waiting for a clearer market trend",
    "Body strength": "waiting for a stronger price move",
    "Asia breakout cross": "waiting for a qualifying setup",
    Breakout: "waiting for a qualifying setup",
    "Causal pre-range": "waiting for a qualifying setup",
    "Close breakout": "waiting for a qualifying setup",
    "Consecutive bars": "waiting for a qualifying setup",
    "Event edge": "waiting for a qualifying setup",
    "Pine bull structure": "waiting for a qualifying setup",
    "Pine consensus": "waiting for a qualifying setup",
    "Simple structure": "waiting for a qualifying setup",
    "V2 external higher-low structure": "waiting for a qualifying setup",
  };
  if (/completed.*utc.*candle/i.test(name)) return "waiting for its scheduled check";
  if (/^Pine /i.test(name)) return "waiting for a qualifying setup";
  return labels[name] ?? name.toLowerCase();
}

function activeBlocker(row: WatchlistStatusInput) {
  const failed = (row.conditions ?? []).filter((condition) => !condition.passed);
  // Without a sweep there is no entry plan. Say that before secondary blockers
  // so the status never implies that Entry / TP / SL already exist.
  return failed.find((condition) => condition.name === "Liquidity sweep")
    ?? failed.find((condition) => condition.required)
    ?? failed[0]
    ?? null;
}

export function watchlistCardStatus(row: WatchlistStatusInput): WatchlistCardStatus {
  const levels = hasLevels(row);
  const progress = watchlistProgress(row);

  if (row.openTradeId) {
    return {
      label: row.tradeSequence ? `Paper trade #${row.tradeSequence} is active` : "Paper trade is active",
      tone: "text-[color:var(--accent)]",
      state: "open",
      progress: 100,
      hasLevels: levels,
    };
  }
  if (row.dataStatus !== "connected") {
    return {
      label: "Live market data unavailable",
      tone: "text-[color:var(--danger)]",
      state: "unavailable",
      progress,
      hasLevels: levels,
    };
  }
  if (row.setupStatus === "valid" && levels) {
    return {
      label: "Trade plan ready — tap to view details",
      tone: "text-[color:var(--success)]",
      state: "ready",
      progress: 100,
      hasLevels: true,
    };
  }

  const strategyEnabled = (row.conditions ?? []).some(
    (condition) => condition.name === "Enabled leg" && condition.passed,
  );
  if (strategyEnabled) {
    return {
      label: "Active strategy — waiting for its scheduled check",
      tone: "text-[color:var(--pending)]",
      state: "developing",
      progress,
      hasLevels: levels,
    };
  }

  const blocker = activeBlocker(row);
  const waitingFor = blocker ? blockerLabel(blocker.name) : "valid setup";
  const developing = levels || progress >= 50;

  return {
    label: levels
      ? `Trade plan forming — ${waitingFor}`
      : waitingFor,
    tone: developing ? "text-[color:var(--pending)]" : "text-[color:var(--muted)]",
    state: developing ? "developing" : "idle",
    progress,
    hasLevels: levels,
  };
}
