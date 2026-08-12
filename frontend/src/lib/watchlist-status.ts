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
    Session: "entry window",
    Spread: "tighter spread",
    News: "clear news window",
    "Liquidity sweep": "liquidity sweep",
    Location: "price at a mapped level",
    "Rejection or displacement": "price confirmation",
    "Structure break": "structure break",
    Macro: "macro confirmation",
    Retest: "retest",
    "Setup score": "setup score",
  };
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
      label: row.tradeSequence ? `Trade #${row.tradeSequence} is open` : "Paper trade is open",
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
      label: "Entry plan ready — tap for Entry / TP / SL",
      tone: "text-[color:var(--success)]",
      state: "ready",
      progress: 100,
      hasLevels: true,
    };
  }

  const blocker = activeBlocker(row);
  const waitingFor = blocker ? blockerLabel(blocker.name) : "valid setup";
  const developing = levels || progress >= 50;

  return {
    label: levels
      ? `Draft Entry / TP / SL — waiting for ${waitingFor}`
      : `Waiting for ${waitingFor}`,
    tone: developing ? "text-[color:var(--pending)]" : "text-[color:var(--muted)]",
    state: developing ? "developing" : "idle",
    progress,
    hasLevels: levels,
  };
}
