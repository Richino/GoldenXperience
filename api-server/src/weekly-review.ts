import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { responseText } from "./analyze-explain.js";
import { query } from "./database.js";
import { journalTradeLog } from "./paper-cycle.js";

/**
 * Home's weekly review: what the trader's own (manual) trades did over the
 * last completed forex week (Sunday 17:00 to Friday 17:00 New York), so it only
 * changes once a week, after the Friday close, the rule-based findings behind the losses, and an AI coach's
 * summary written only from those numbers. Each week's review is saved
 * (weekly_reviews, one row per user per New York week), the saved summary is
 * reused while the week's trades are unchanged, and past weeks are handed to
 * the next summary so mistakes that keep coming back are called out.
 */

const HISTORY_WEEKS = 8;
const TIMEOUT_MS = 30_000;

type JournalRow = {
  id: string;
  origin: string;
  pair: string;
  direction: "long" | "short";
  status: string;
  result: string;
  openedAt: string | Date;
  closedAt: string | Date | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  exit: number | null;
  resultR: number | null;
  paperPl: number | null;
  instrument: string | null;
  slPrice?: number | null;
  tpPrice?: number | null;
  oandaEntryHalfSpreadCost?: number | null;
  brokerExecutionStatus?: string | null;
};

type ExitKind = "stop" | "target" | "manual";

type Trade = {
  id: string;
  pair: string;
  direction: "long" | "short";
  openedAt: number;
  closedAt: number;
  r: number | null;
  pl: number | null;
  spread: number;
  holdMinutes: number;
  exit: ExitKind;
  hadStop: boolean;
  hadTarget: boolean;
  plannedR: number | null;
};

type Bucket = { key: string; trades: number; wins: number; netR: number; netPl: number };

export type WeeklyFinding = {
  id: string;
  title: string;
  detail: string;
  /** Account money this pattern cost (negative) or made; null when not measurable. */
  impact: number | null;
};

export type WeeklyStats = {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  netR: number;
  netPl: number;
  avgWinR: number | null;
  avgLossR: number | null;
  avgWinPl: number | null;
  avgLossPl: number | null;
  profitFactor: number | null;
  spreadPaid: number;
  avgHoldWinMinutes: number | null;
  avgHoldLossMinutes: number | null;
  exits: Record<ExitKind, number>;
  noStopTrades: number;
  noStopPl: number;
  maxLossStreak: number;
  largestLossPl: number | null;
  largestLossR: number | null;
  byPair: Bucket[];
  bySession: Bucket[];
  byDirection: Bucket[];
  byDay: Bucket[];
};

/** A saved earlier week, trimmed to what the coach and the page need. */
export type WeeklyHistoryItem = {
  weekStart: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPl: number;
  netR: number;
  noStopTrades: number;
  avgHoldWinMinutes: number | null;
  avgHoldLossMinutes: number | null;
  exits: Record<ExitKind, number>;
  findings: Array<{ id: string; title: string }>;
  focus: string | null;
};

export type WeeklyReview = {
  /** Monday (New York) of the week this review is saved under. */
  weekStart: string;
  /** Earlier saved weeks, newest first; empty until some are saved. */
  history: WeeklyHistoryItem[];
  from: string;
  to: string;
  stats: WeeklyStats;
  findings: WeeklyFinding[];
  /** Changes whenever the week's trades change; keys the cached summary. */
  fingerprint: string;
};

const etHour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/New_York" });
const etDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });

function sessionOf(time: number) {
  const hour = Number(etHour.format(new Date(time)));
  if (hour >= 19 || hour < 3) return "Asia";
  if (hour < 8) return "London";
  if (hour < 12) return "New York AM";
  if (hour < 17) return "New York PM";
  return "Evening";
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null);

function toTrade(row: JournalRow): Trade | null {
  if (row.status !== "closed" || !row.closedAt || row.brokerExecutionStatus === "rejected") return null;
  const openedAt = new Date(row.openedAt).getTime();
  const closedAt = new Date(row.closedAt).getTime();
  if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt)) return null;
  const instrument = row.instrument ?? row.pair.replace("/", "_");
  const pip = pipSizeFor(instrument);
  // The levels the trade actually held; older rows only have stop/target.
  const sl = row.slPrice === undefined ? row.stop : row.slPrice;
  const tp = row.tpPrice === undefined ? row.target : row.tpPrice;
  const near = (a: number | null | undefined, b: number | null | undefined) =>
    a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= 1.5 * pip;
  const exit: ExitKind = near(row.exit, sl) ? "stop" : near(row.exit, tp) && tp !== row.entry ? "target" : "manual";
  const risk = row.entry !== null && sl !== null && sl !== undefined ? Math.abs(row.entry - sl) : null;
  const plannedR = risk && tp !== null && tp !== undefined && row.entry !== null ? Math.abs(tp - row.entry) / risk : null;
  return {
    id: row.id,
    pair: row.pair,
    direction: row.direction,
    openedAt,
    closedAt,
    r: row.resultR === null || row.resultR === undefined ? null : Number(row.resultR),
    pl: row.paperPl === null || row.paperPl === undefined ? null : Number(row.paperPl),
    spread: Math.abs(Number(row.oandaEntryHalfSpreadCost ?? 0)) || 0,
    holdMinutes: Math.max(0, (closedAt - openedAt) / 60_000),
    exit,
    hadStop: sl !== null && sl !== undefined,
    hadTarget: tp !== null && tp !== undefined && tp !== row.entry,
    plannedR,
  };
}

const outcome = (trade: Trade) => trade.pl ?? trade.r ?? 0;

function bucket(trades: Trade[], keyOf: (trade: Trade) => string): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const entry = map.get(key) ?? { key, trades: 0, wins: 0, netR: 0, netPl: 0 };
    entry.trades += 1;
    if (outcome(trade) > 0) entry.wins += 1;
    entry.netR += trade.r ?? 0;
    entry.netPl += trade.pl ?? 0;
    map.set(key, entry);
  }
  return [...map.values()]
    .map((entry) => ({ ...entry, netR: round(entry.netR), netPl: round(entry.netPl) }))
    .sort((a, b) => a.netPl - b.netPl || a.netR - b.netR);
}

function statsOf(trades: Trade[]): WeeklyStats {
  const wins = trades.filter((trade) => outcome(trade) > 0);
  const losses = trades.filter((trade) => outcome(trade) < 0);
  const grossWin = sum(wins.map((trade) => trade.pl ?? 0));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.pl ?? 0)));
  let streak = 0;
  let maxLossStreak = 0;
  for (const trade of [...trades].sort((a, b) => a.closedAt - b.closedAt)) {
    streak = outcome(trade) < 0 ? streak + 1 : 0;
    maxLossStreak = Math.max(maxLossStreak, streak);
  }
  const worst = [...losses].sort((a, b) => outcome(a) - outcome(b))[0];
  const noStop = trades.filter((trade) => !trade.hadStop);
  const exits: Record<ExitKind, number> = { stop: 0, target: 0, manual: 0 };
  for (const trade of trades) exits[trade.exit] += 1;
  const opt = (value: number | null, digits = 2) => (value === null ? null : round(value, digits));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRate: wins.length + losses.length ? round((wins.length / (wins.length + losses.length)) * 100, 0) : null,
    netR: round(sum(trades.map((trade) => trade.r ?? 0))),
    netPl: round(sum(trades.map((trade) => trade.pl ?? 0))),
    avgWinR: opt(mean(wins.flatMap((trade) => (trade.r === null ? [] : [trade.r])))),
    avgLossR: opt(mean(losses.flatMap((trade) => (trade.r === null ? [] : [trade.r])))),
    avgWinPl: opt(mean(wins.flatMap((trade) => (trade.pl === null ? [] : [trade.pl])))),
    avgLossPl: opt(mean(losses.flatMap((trade) => (trade.pl === null ? [] : [trade.pl])))),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    spreadPaid: round(sum(trades.map((trade) => trade.spread))),
    avgHoldWinMinutes: opt(mean(wins.map((trade) => trade.holdMinutes)), 0),
    avgHoldLossMinutes: opt(mean(losses.map((trade) => trade.holdMinutes)), 0),
    exits,
    noStopTrades: noStop.length,
    noStopPl: round(sum(noStop.map((trade) => trade.pl ?? 0))),
    maxLossStreak,
    largestLossPl: worst?.pl === null || worst?.pl === undefined ? null : round(worst.pl),
    largestLossR: worst?.r === null || worst?.r === undefined ? null : round(worst.r),
    byPair: bucket(trades, (trade) => trade.pair),
    bySession: bucket(trades, (trade) => sessionOf(trade.openedAt)),
    byDirection: bucket(trades, (trade) => (trade.direction === "long" ? "Long" : "Short")),
    byDay: bucket(trades, (trade) => etDay.format(new Date(trade.openedAt))),
  };
}

const money = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
const minutes = (value: number) => (value >= 120 ? `${(value / 60).toFixed(1)}h` : `${Math.round(value)}m`);

/** Rule-based findings, the costliest first. Each states its own numbers. */
function findingsOf(trades: Trade[], stats: WeeklyStats): WeeklyFinding[] {
  const findings: WeeklyFinding[] = [];
  if (stats.noStopTrades > 0 && stats.noStopPl < 0) {
    findings.push({ id: "no-stop", title: "Trades without a stop", impact: stats.noStopPl,
      detail: `${stats.noStopTrades} of ${stats.trades} trades had no stop loss and together made ${money(stats.noStopPl)}.` });
  }
  const worstPair = stats.byPair[0];
  if (worstPair && worstPair.netPl < 0 && stats.byPair.length > 1) {
    findings.push({ id: "worst-pair", title: `${worstPair.key} cost the most`, impact: worstPair.netPl,
      detail: `${worstPair.key}: ${worstPair.trades} trades, ${worstPair.wins} winners, ${money(worstPair.netPl)} (${worstPair.netR}R).` });
  }
  const worstSession = stats.bySession[0];
  if (worstSession && worstSession.netPl < 0 && stats.bySession.length > 1) {
    findings.push({ id: "worst-session", title: `${worstSession.key} session was the weakest`, impact: worstSession.netPl,
      detail: `Trades opened in the ${worstSession.key} session: ${worstSession.trades} trades, ${money(worstSession.netPl)} (${worstSession.netR}R).` });
  }
  if (stats.avgHoldLossMinutes !== null && stats.avgHoldWinMinutes !== null && stats.avgHoldLossMinutes > stats.avgHoldWinMinutes * 1.5) {
    findings.push({ id: "held-losers", title: "Losers held longer than winners", impact: stats.avgLossPl,
      detail: `Losing trades were held ${minutes(stats.avgHoldLossMinutes)} on average, winners ${minutes(stats.avgHoldWinMinutes)}.` });
  }
  const earlyWins = trades.filter((trade) => trade.exit === "manual" && outcome(trade) > 0 && trade.hadTarget && trade.r !== null && trade.plannedR !== null && trade.r < trade.plannedR * 0.6);
  if (earlyWins.length >= 2) {
    const captured = round(mean(earlyWins.map((trade) => trade.r ?? 0)) ?? 0);
    const planned = round(mean(earlyWins.map((trade) => trade.plannedR ?? 0)) ?? 0);
    findings.push({ id: "early-wins", title: "Winners closed early", impact: null,
      detail: `${earlyWins.length} winners were closed by hand at ${captured}R on average against a planned ${planned}R.` });
  }
  if (stats.avgWinPl !== null && stats.avgLossPl !== null && Math.abs(stats.avgLossPl) > stats.avgWinPl) {
    findings.push({ id: "loss-size", title: "Average loss is bigger than average win", impact: round(stats.avgLossPl + stats.avgWinPl),
      detail: `Average winner ${money(stats.avgWinPl)}, average loser ${money(stats.avgLossPl)}.` });
  }
  if (stats.spreadPaid > 0 && stats.netPl !== 0 && stats.spreadPaid >= Math.abs(stats.netPl) * 0.25) {
    findings.push({ id: "spread", title: "Spread ate a large share", impact: -stats.spreadPaid,
      detail: `${money(stats.spreadPaid)} paid in entry spread this week, against a net of ${money(stats.netPl)}.` });
  }
  if (stats.maxLossStreak >= 3) {
    findings.push({ id: "streak", title: "Losing streak", impact: null,
      detail: `${stats.maxLossStreak} losing trades in a row at the worst point of the week.` });
  }
  const busiest = [...stats.byDay].sort((a, b) => b.trades - a.trades)[0];
  if (busiest && busiest.trades >= 5 && busiest.netPl < 0) {
    findings.push({ id: "overtrading", title: `Most trades on ${busiest.key}, and it lost`, impact: busiest.netPl,
      detail: `${busiest.trades} trades on ${busiest.key} for ${money(busiest.netPl)}.` });
  }
  return findings.sort((a, b) => (a.impact ?? 0) - (b.impact ?? 0));
}

const isMissingTable = (error: unknown) => (error as { code?: string } | null)?.code === "42P01";

async function savedHistory(userId: string, weekStart: string): Promise<WeeklyHistoryItem[]> {
  try {
    const rows = await query<{ week_start: string | Date; stats: WeeklyStats; findings: WeeklyFinding[]; summary: WeeklySummary | null }>(
      `SELECT week_start, stats, findings, summary FROM weekly_reviews
        WHERE user_id=$1 AND week_start < $2::date ORDER BY week_start DESC LIMIT $3`,
      [userId, weekStart, HISTORY_WEEKS],
    );
    return rows.rows.map((row) => ({
      weekStart: typeof row.week_start === "string" ? row.week_start.slice(0, 10) : row.week_start.toISOString().slice(0, 10),
      trades: row.stats.trades,
      wins: row.stats.wins,
      losses: row.stats.losses,
      winRate: row.stats.winRate,
      netPl: row.stats.netPl,
      netR: row.stats.netR,
      noStopTrades: row.stats.noStopTrades,
      avgHoldWinMinutes: row.stats.avgHoldWinMinutes,
      avgHoldLossMinutes: row.stats.avgHoldLossMinutes,
      exits: row.stats.exits,
      findings: row.findings.map((finding) => ({ id: finding.id, title: finding.title })),
      focus: row.summary?.focus ?? null,
    }));
  } catch (error) {
    // Before the migration runs there is simply no history yet.
    if (isMissingTable(error)) return [];
    throw error;
  }
}

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

function partsEt(time: number) {
  const parts = Object.fromEntries(etParts.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday as string };
}

/** A New York wall-clock time as a UTC timestamp (DST-aware). */
function etWallTime(year: number, month: number, day: number, hour: number) {
  let guess = Date.UTC(year, month - 1, day, hour);
  for (let i = 0; i < 3; i += 1) {
    const seen = partsEt(guess);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += Date.UTC(year, month - 1, day, hour) - seenAsUtc;
  }
  return guess;
}

/**
 * The last completed forex week: Sunday 17:00 to Friday 17:00 New York, ending
 * at the most recent Friday close. Before this Friday's close it is the week
 * before, so the review holds still all week and refreshes once, after Friday.
 */
export function completedTradingWeek(now: number) {
  const today = partsEt(now);
  const weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(today.weekday); // Mon = 0
  let daysBack = (weekdayIndex - 4 + 7) % 7; // back to Friday
  if (daysBack === 0 && today.hour < 17) daysBack = 7; // Friday before the close: last week
  const friday = new Date(Date.UTC(today.year, today.month - 1, today.day - daysBack));
  const [y, m, d] = [friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate()];
  const to = etWallTime(y, m, d, 17);
  const from = etWallTime(y, m, d - 5, 17);
  const monday = new Date(Date.UTC(y, m - 1, d - 4)).toISOString().slice(0, 10);
  return { from, to, weekStart: monday };
}

export async function weeklyReview(userId: string, now = Date.now()): Promise<WeeklyReview> {
  const rows = (await journalTradeLog(userId, { limit: 500, filter: "all" })) as unknown as JournalRow[];
  const { from, to, weekStart } = completedTradingWeek(now);
  const trades = rows
    .filter((row) => row.origin === "manual")
    .map(toTrade)
    .filter((trade): trade is Trade => trade !== null && trade.closedAt >= from && trade.closedAt < to)
    .sort((a, b) => a.closedAt - b.closedAt);
  const stats = statsOf(trades);
  return {
    weekStart,
    history: await savedHistory(userId, weekStart),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    stats,
    findings: findingsOf(trades, stats),
    fingerprint: trades.map((trade) => `${trade.id}:${trade.r ?? ""}:${trade.pl ?? ""}`).join("|"),
  };
}

/* ------------------------------------------------------------ AI summary */

export type WeeklySummary = {
  summary: string;
  /** Mistakes that also showed up in earlier saved weeks; empty without history. */
  recurring: Array<{ title: string; detail: string }>;
  /** Whether last week's focus was followed, from the numbers; empty without history. */
  lastFocusCheck: string;
  mistakes: Array<{ title: string; detail: string }>;
  improvements: Array<{ title: string; detail: string }>;
  focus: string;
};

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "recurring", "lastFocusCheck", "mistakes", "improvements", "focus"],
  properties: {
    summary: { type: "string" },
    recurring: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
    lastFocusCheck: { type: "string" },
    mistakes: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
    improvements: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
    focus: { type: "string" },
  },
} as const;

const RULES = [
  "Use only the facts given. Every number you write must appear in the facts; never compute new numbers, percentages or totals.",
  "Speak to the trader directly (you, your). Plain words, no jargon, no hype, no emojis.",
  "Describe what happened over these trades and what to change. Never predict the market, promise results, or talk about win probability.",
  "mistakes: 1 to 4 items, the costliest first, each grounded in a finding or a breakdown.",
  "improvements: 2 to 4 concrete, checkable habits for next week (for example: always set a stop before entering).",
  "focus: one short sentence, the single most important rule for next week.",
  "If there are fewer than 3 trades, say the sample is too small to judge and keep the advice general.",
  "history holds the trader's earlier saved weeks, newest first. recurring: 0 to 3 mistakes that ALSO appear in history (the same finding id, or the same pattern in the numbers), naming how many weeks it has shown up. Empty when history is empty or nothing repeats.",
  "lastFocusCheck: when history has a focus for the most recent earlier week, one or two sentences on whether this week's numbers show it was followed; otherwise an empty string.",
];

/** What each fact means, so the model cannot misread a count. */
const FIELD_MEANINGS = {
  "stats.exits": "How trades CLOSED: stop = closed at its stop loss, target = closed at its take profit, manual = closed by hand. This is not how many trades had a stop.",
  "stats.noStopTrades": "Trades that had no stop loss set at all; noStopPl is their combined money result.",
  "stats.avgHoldWinMinutes / avgHoldLossMinutes": "Average time winners / losers were held, in minutes.",
  "stats.netR / avgWinR / avgLossR": "R measured against each trade's original sizing stop.",
  "stats.spreadPaid": "Money paid in entry spread across these trades.",
  "stats.bySession": "Grouped by the New York time each trade was opened: Asia 19-03, London 03-08, New York AM 08-12, New York PM 12-17, Evening 17-19.",
  "findings": "Rule-based problems, the costliest first; impact is money.",
  "history": "Earlier saved weeks (weekStart = Monday, New York), newest first, with their findings and the focus that week set.",
};

/** Every number the summary may use, at the precisions the facts show. */
function allowedNumbers(value: unknown, out = new Set<string>()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    for (const v of [value, Math.abs(value)]) {
      out.add(String(v));
      for (const digits of [0, 1, 2]) out.add(v.toFixed(digits));
    }
  } else if (typeof value === "string") {
    for (const match of value.match(/\d+(?:\.\d+)?/g) ?? []) out.add(match);
  } else if (Array.isArray(value)) value.forEach((item) => allowedNumbers(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => allowedNumbers(item, out));
  return out;
}

function validateSummary(value: unknown, review: WeeklyReview): { ok: true; summary: WeeklySummary } | { ok: false; reason: string } {
  const candidate = value as WeeklySummary;
  if (!candidate || typeof candidate.summary !== "string" || typeof candidate.focus !== "string" || typeof candidate.lastFocusCheck !== "string"
    || !Array.isArray(candidate.mistakes) || !Array.isArray(candidate.improvements) || !Array.isArray(candidate.recurring)) return { ok: false, reason: "wrong shape" };
  const allowed = allowedNumbers(review);
  const texts = [candidate.summary, candidate.focus, candidate.lastFocusCheck, ...candidate.recurring.flatMap((item) => [item.title, item.detail]), ...candidate.mistakes.flatMap((item) => [item.title, item.detail]), ...candidate.improvements.flatMap((item) => [item.title, item.detail])];
  for (const text of texts) {
    if (/probabilit|guarantee|will (?:win|profit)|chance of winning/i.test(text)) return { ok: false, reason: "prediction language" };
    for (const number of text.replace(/[,$]/g, "").match(/\d+(?:\.\d+)?/g) ?? []) {
      // Small counts ("2 habits", "1 rule") are fine; any other figure must come from the facts.
      if (Number(number) <= 10 && !number.includes(".")) continue;
      if (!allowed.has(number)) return { ok: false, reason: `number ${number} is not in the facts` };
    }
  }
  return {
    ok: true,
    summary: {
      summary: candidate.summary.trim(),
      focus: candidate.focus.trim(),
      recurring: review.history.length ? candidate.recurring.slice(0, 3) : [],
      lastFocusCheck: review.history.length ? candidate.lastFocusCheck.trim() : "",
      mistakes: candidate.mistakes.slice(0, 4),
      improvements: candidate.improvements.slice(0, 4),
    },
  };
}

/** This week's saved summary, if it was written from the same trades. */
async function savedSummary(userId: string, review: WeeklyReview) {
  try {
    const rows = await query<{ fingerprint: string; summary: WeeklySummary | null; model: string | null }>(
      "SELECT fingerprint, summary, model FROM weekly_reviews WHERE user_id=$1 AND week_start=$2::date",
      [userId, review.weekStart],
    );
    const row = rows.rows[0];
    return row && row.fingerprint === review.fingerprint && row.summary && Array.isArray(row.summary.recurring)
      ? { summary: row.summary, model: row.model ?? "" }
      : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

async function saveReview(userId: string, review: WeeklyReview, value: { summary: WeeklySummary; model: string }) {
  try {
    await query(
      `INSERT INTO weekly_reviews (user_id, week_start, window_from, window_to, fingerprint, stats, findings, summary, model)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, week_start) DO UPDATE SET window_from=EXCLUDED.window_from, window_to=EXCLUDED.window_to,
         fingerprint=EXCLUDED.fingerprint, stats=EXCLUDED.stats, findings=EXCLUDED.findings,
         summary=EXCLUDED.summary, model=EXCLUDED.model, updated_at=now()`,
      [userId, review.weekStart, review.from, review.to, review.fingerprint, JSON.stringify(review.stats), JSON.stringify(review.findings), JSON.stringify(value.summary), value.model],
    );
  } catch (error) {
    // Not migrated yet: the summary still shows, it just is not kept.
    if (!isMissingTable(error)) throw error;
  }
}

export async function weeklySummary(userId: string, review: WeeklyReview): Promise<{ summary: WeeklySummary; model: string }> {
  const saved = await savedSummary(userId, review);
  if (saved) return saved;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("AI summaries are not configured (OPENAI_API_KEY).");
  const model = process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini";
  const facts = { window: { from: review.from, to: review.to }, stats: review.stats, findings: review.findings, history: review.history };
  const request = async () => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model,
        reasoning: { effort: "low" },
        input: JSON.stringify({
          task: "You are a trading coach reviewing one trader's own forex trades from their last completed trading week (Sunday to Friday close), with their earlier saved weeks for context. Explain where they went wrong, which mistakes keep repeating, and what to do to improve, from these measured facts only.",
          rules: RULES,
          fieldMeanings: FIELD_MEANINGS,
          facts,
        }),
        text: { format: { type: "json_schema", name: "weekly_review", strict: true, schema: SUMMARY_SCHEMA } },
      }),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new Error(`The summary model could not respond (${response.status}).`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText(payload));
    } catch {
      throw new Error("The summary was unreadable.");
    }
    return validateSummary(parsed, review);
  };
  // One retry when the model slips a number in that the facts do not have.
  let checked = await request();
  if (!checked.ok) checked = await request();
  if (!checked.ok) throw new Error(`Summary rejected: ${checked.reason}`);
  const value = { summary: checked.summary, model };
  await saveReview(userId, review, value);
  return value;
}
