export type WatchlistCondition = {
  name: string;
  passed: boolean;
  required?: boolean;
};

export type WatchlistStatusInput = {
  instrument: string;
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

/**
 * Exact execution-check times, expressed as minutes after midnight UTC.
 * These are completion times: a strategy first evaluates its scheduled candle
 * after that candle has closed. This map contains only executable strategy
 * runtimes; a scheduled-but-not-yet-executable pair is kept separate below.
 */
const ACTIVE_PAIR_CHECK_MINUTES_UTC: Readonly<Record<string, readonly number[]>> = {
  EUR_JPY: [7 * 60],
  EUR_USD: [7 * 60, 8 * 60, 9 * 60, 10 * 60, 11 * 60],
  GBP_USD: [11 * 60, 11 * 60 + 30],
  USD_JPY: [12 * 60, 13 * 60, 14 * 60, 15 * 60],
  AUD_USD: [12 * 60],
  NZD_USD: [12 * 60],
  USD_CAD: [12 * 60],
  USD_CHF: [12 * 60],
  CAD_JPY: [13 * 60],
  NZD_JPY: [0],
};

/**
 * Known strategy evaluation times, including a schedule supplied before its
 * execution runtime has been implemented. AUD/JPY evaluates the H1 candle
 * that opens at 12:00 UTC, so it can only be checked after 13:00 UTC.
 */
const PAIR_CHECK_MINUTES_UTC: Readonly<Record<string, readonly number[]>> = {
  ...ACTIVE_PAIR_CHECK_MINUTES_UTC,
  AUD_JPY: [13 * 60],
};

export function hasActivePairStrategy(instrument: string) {
  return instrument in ACTIVE_PAIR_CHECK_MINUTES_UTC;
}

export function hasPairStrategySchedule(instrument: string) {
  return instrument in PAIR_CHECK_MINUTES_UTC;
}

/** Returns the next time this pair's strategy can evaluate, in the user's local time zone. */
export function nextPairStrategyCheck(instrument: string, now = new Date()) {
  const checks = PAIR_CHECK_MINUTES_UTC[instrument];
  if (!checks?.length) return null;

  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return checks
    .map((minutes) => {
      const candidate = new Date(todayStart + minutes * 60_000);
      return candidate.getTime() > now.getTime()
        ? candidate
        : new Date(candidate.getTime() + 24 * 60 * 60_000);
    })
    .sort((left, right) => left.getTime() - right.getTime())[0]!;
}

export function pairStrategyScheduleLabel(instrument: string, now = new Date()) {
  const next = nextPairStrategyCheck(instrument, now);
  if (!next) return "No active strategy";
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(next);
  return `Next check ${time}`;
}

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
  if (!hasActivePairStrategy(row.instrument)) {
    if (hasPairStrategySchedule(row.instrument)) {
      return {
        label: "Scheduled 12:00 UTC candle — runtime not enabled",
        tone: "text-[color:var(--pending)]",
        state: "idle",
        progress: 0,
        hasLevels: false,
      };
    }
    return {
      label: "No active strategy for this pair",
      tone: "text-[color:var(--muted)]",
      state: "idle",
      progress: 0,
      hasLevels: false,
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
