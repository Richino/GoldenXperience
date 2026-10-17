import { randomUUID } from "node:crypto";
import {
  OandaRequestError,
  closePracticeTrade,
  getPracticeOrderByClientId,
  getPracticeTradeProtection,
  getPracticeTradeState,
  getPricing,
  oandaEnvironment,
  setPracticeTradeLevels,
  submitPracticeNewsMarketOrder,
} from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { currenciesOf, pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import type { MajorInstrument, MarketPriceTick } from "./market-stream-types.js";
import { query, transaction } from "./database.js";
import { displayPair, queueNotification } from "./notifications.js";
import {
  PENDING_ENTRY_FIELDS,
  manualBrokerCloseResultR,
  manualPositionSize,
  serializePendingManualEntry,
  type PendingEntryRow,
} from "./pending-manual-entries.js";
import { reconcileDecision, submitFailureKind } from "./trade-plan-execution-checks.js";

/**
 * News mode: a first-zone-touch breakout around one economic release.
 *
 * A setup is two linked rows in pending_manual_entries (a BUY side and a
 * SELL side) sharing metadata.straddleId. Nothing rests at OANDA. The
 * setup's lifecycle is an explicit state machine held in metadata.newsState
 * on both rows, changed only by compare-and-set transitions (the update
 * names the states it may move from) under a per-setup advisory lock, with
 * every step appended to metadata.timeline. The Railway server owns it all;
 * the browser only reads it.
 *
 *   ARMED ──lock time──▶ (LOCKING) ──▶ ZONES_LOCKED ──release──▶ WATCHING
 *     zones follow the       no valid      zones frozen;            first zone touch
 *     live price; no         quote yet:    no trading               │
 *     trading                retry until                            ▼
 *                            release, then SKIPPED     TRIGGER_RESERVED (one side, other side off)
 *                                                                   │ persisted before sending
 *                                                                   ▼
 *                                                       ORDER_SUBMITTING ─timeout─▶ ORDER_UNKNOWN
 *                                                         │        │                  │ looked up by
 *                                                         │        └─reject──▶ ORDER_REJECTED  client id,
 *                                                         ▼                           never resent
 *                                                       FILLED ──time exit──▶ CLOSING ──▶ CLOSED
 *                                                         └──── stop / target / manual ──▶ CLOSED
 *   Side exits: EXPIRED (no zone touch in the watch window), SKIPPED (no
 *   anchor before release, release moved, price jumped past the zone, kill
 *   switch, reserved but not sent), CANCELLED (by the user before an order),
 *   ERROR (a fill OANDA would not protect).
 *
 * BUY is judged on the executable ask, SELL on the bid. The order is a FOK
 * market order whose priceBound is the zone's far edge, so OANDA cancels it
 * rather than fill outside the zone. The stop rides on the order as a
 * distance from the open price (protected from the instant of the fill);
 * OANDA has no distance form for a take-profit, so the target is moved to
 * fill ± target pips right after the fill and read back before it is
 * reported.
 */

export const NEWS_CONFIG_VERSION = 2;
/** Releases count as "news ahead" this far out; News mode arms only for one. */
export const NEWS_LOOKAHEAD_MS = 5 * 60 * 60_000;
/** Zones lock this long before the release. */
export const NEWS_LOCK_LEAD_MS = 60_000;
/** A quote older than this is not used to lock zones or to trigger. */
export const NEWS_MAX_QUOTE_AGE_MS = 5_000;
const RECONCILE_AFTER_MS = 15_000;
const GIVE_UP_AFTER_MS = 3 * 60_000;
const RESERVED_ORPHAN_MS = 15_000;
const CLOSING_RETRY_MS = 30_000;

export const NEWS_STATES = [
  "ARMED", "LOCKING", "ZONES_LOCKED", "WATCHING", "TRIGGER_RESERVED", "ORDER_SUBMITTING", "ORDER_UNKNOWN",
  "ORDER_REJECTED", "FILLED", "CLOSING", "CLOSED", "EXPIRED", "SKIPPED", "CANCELLED", "ERROR",
] as const;
export type NewsState = typeof NEWS_STATES[number];

/** Every allowed move. Anything else is refused, so a state can never be skipped or reversed. */
export const NEWS_TRANSITIONS: Record<NewsState, readonly NewsState[]> = {
  ARMED: ["LOCKING", "ZONES_LOCKED", "SKIPPED", "CANCELLED", "ERROR"],
  LOCKING: ["ZONES_LOCKED", "SKIPPED", "CANCELLED", "ERROR"],
  ZONES_LOCKED: ["WATCHING", "SKIPPED", "CANCELLED", "ERROR"],
  WATCHING: ["TRIGGER_RESERVED", "SKIPPED", "EXPIRED", "CANCELLED", "ERROR"],
  TRIGGER_RESERVED: ["ORDER_SUBMITTING", "SKIPPED", "ERROR"],
  ORDER_SUBMITTING: ["FILLED", "ORDER_REJECTED", "ORDER_UNKNOWN", "ERROR"],
  ORDER_UNKNOWN: ["FILLED", "ORDER_REJECTED", "ERROR"],
  FILLED: ["CLOSING", "CLOSED", "ERROR"],
  CLOSING: ["CLOSED", "ERROR"],
  ORDER_REJECTED: [],
  CLOSED: [],
  EXPIRED: [],
  SKIPPED: [],
  CANCELLED: [],
  ERROR: ["CLOSED"],
};

export function canTransition(from: NewsState, to: NewsState) {
  return NEWS_TRANSITIONS[from].includes(to);
}

/** States in which the server watches prices for this setup. */
const LIVE_STATES: NewsState[] = ["ARMED", "LOCKING", "ZONES_LOCKED", "WATCHING"];
/** States a user cancel may end: no order has been reserved yet. */
const CANCELLABLE: NewsState[] = ["ARMED", "LOCKING", "ZONES_LOCKED", "WATCHING"];

export type NewsEvent =
  | "news_setup_armed" | "news_zones_locked" | "news_watch_started" | "news_zone_triggered" | "news_order_submitting"
  | "news_order_filled" | "news_order_rejected" | "news_order_unknown" | "news_setup_skipped" | "news_setup_expired"
  | "news_setup_cancelled" | "news_trade_closed" | "news_execution_error" | "news_spread_blocked";

/** Events recorded on the timeline and in the logs but not pushed: they land within milliseconds of the fill or rejection that is. */
const QUIET_EVENTS = new Set<NewsEvent>(["news_zone_triggered", "news_order_submitting"]);

export type NewsStraddleSide = "long" | "short";

export type NewsStraddleSettings = {
  distancePips: number;
  stopPips: number;
  targetPips: number;
  slippagePips: number;
  spreadCapPips: number;
  /** How long it watches after the release. */
  armedMinutes: number;
  /** 0 = no time exit. */
  closeAfterMinutes: number;
  release: { id: string | null; title: string; currency: string | null; time: string };
};

/** Ascending bounds: buy.lower is the BUY entry edge, sell.upper the SELL entry edge. */
export type NewsZones = { buy: { lower: number; upper: number }; sell: { lower: number; upper: number } };

type NewsMeta = {
  mode: "news";
  straddleId: string;
  line: "upper" | "lower";
  newsState: NewsState;
  configVersion: number;
  distancePips: number;
  stopPips: number;
  targetPips: number;
  slippagePips: number;
  spreadCapPips: number;
  closeAfterMinutes: number;
  armedMinutes: number;
  units: number;
  riskPercent: number;
  release: NewsStraddleSettings["release"];
  lockAt: string;
  pipSize: number;
  precision: number;
  zones?: NewsZones | null;
  anchor?: number | null;
  lockedAt?: string | null;
  reservation?: { attemptId: string; side: NewsStraddleSide; clientRequestId: string; priceBound: number; triggerBid: number; triggerAsk: number; triggerQuoteTime: string; spreadPips: number; reservedAt: string } | null;
  submittedAt?: string;
  brokerTradeId?: string;
  timeExitAt?: string | null;
  closingClaimedAt?: string;
  spreadBlockedAt?: string;
};

type Queryable = { query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }> };

/** Everything with a side effect, so tests can run on one rolled-back connection with a fake broker and clock. */
export type NewsDeps = {
  db: Queryable & { tx: <T>(fn: (client: Queryable) => Promise<T>) => Promise<T> };
  broker: {
    submit: typeof submitPracticeNewsMarketOrder;
    orderByClientId: typeof getPracticeOrderByClientId;
    tradeState: typeof getPracticeTradeState;
    protection: typeof getPracticeTradeProtection;
    closeTrade: typeof closePracticeTrade;
    setLevels: typeof setPracticeTradeLevels;
    environment: () => string | null;
  };
  size: (userId: string, instrument: MajorInstrument, entry: number, stop: number) => Promise<{ units: number; riskPercent: number }>;
  notify: (input: { userId: string; instrument: string; key: string; event: NewsEvent; title: string; message: string }) => Promise<void>;
  /** Calendar releases (null when the calendar can't be read). */
  releases: () => Promise<Array<{ currency: string; title: string; timestamp: string }> | null>;
  /** A live quote, for locking when no stream tick arrives. */
  quote: (instrument: MajorInstrument) => Promise<MarketPriceTick | null>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
};

export const liveNewsDeps: NewsDeps = {
  db: {
    query: (text, values) => query(text, values) as never,
    tx: (fn) => transaction((client) => fn(client as unknown as Queryable)),
  },
  broker: {
    submit: submitPracticeNewsMarketOrder,
    orderByClientId: getPracticeOrderByClientId,
    tradeState: getPracticeTradeState,
    protection: getPracticeTradeProtection,
    closeTrade: closePracticeTrade,
    setLevels: setPracticeTradeLevels,
    environment: oandaEnvironment,
  },
  size: (userId, instrument, entry, stop) => manualPositionSize(userId, instrument, entry, stop),
  notify: async (input) => {
    await queueNotification({
      userId: input.userId,
      kind: input.event === "news_execution_error" ? "system_issue" : "trade_update",
      title: input.title,
      message: input.message,
      instrument: input.instrument,
      paperTradeId: null,
      dedupeKey: `news-straddle:${input.key}:${input.event}`,
    }).catch((error) => console.error(`[news-straddle] notification failed for ${input.key}`, error));
  },
  releases: async () => {
    const calendar = await getEconomicCalendar().catch(() => null);
    if (!calendar || calendar.status.state !== "connected" || !calendar.data.connected || calendar.data.source === "mock") return null;
    return [...calendar.data.events, ...(calendar.data.recentEvents ?? [])];
  },
  quote: async (instrument) => {
    const pricing = await getPricing([instrument]).catch(() => null);
    const price = pricing?.status.state === "connected" ? pricing.data.find((item) => item.instrument === instrument) : null;
    if (!price || pricing?.status.source !== "oanda" || !(price.bid > 0) || !(price.ask >= price.bid)) return null;
    return { type: "price", instrument, displayName: price.displayName, bid: price.bid, ask: price.ask, mid: price.mid, spread: price.ask - price.bid, status: price.status, time: price.time, source: "oanda", sequence: Date.now() };
  },
  now: () => Date.now(),
  // One JSON line per step; no credentials ever reach it.
  log: (entry) => console.log(`[news-straddle] ${JSON.stringify(entry)}`),
};

// ── Pure geometry and decisions ───────────────────────────────────────

/** Integer price steps at the instrument's precision, so boundary tests never meet float error. */
function steps(price: number, precision: number) {
  return Math.round(price * 10 ** precision);
}

/** The two zones around an anchor: entry edge `distance` pips out, far edge `depth` pips further. */
export function newsZones(instrument: string, anchor: number, distancePips: number, depthPips: number): NewsZones {
  const pip = pipSizeFor(instrument);
  const precision = precisionFor(instrument);
  const r = (value: number) => Number(value.toFixed(precision));
  const buyLower = r(anchor + distancePips * pip);
  const sellUpper = r(anchor - distancePips * pip);
  return {
    buy: { lower: buyLower, upper: r(buyLower + depthPips * pip) },
    sell: { lower: r(sellUpper - depthPips * pip), upper: sellUpper },
  };
}

export type NewsQuote = { bid: number; ask: number; time: string; tradeable: boolean };

/** Why a quote cannot be used: crossed, non-positive, not tradeable or stale. Null when usable. */
export function quoteProblem(quote: NewsQuote, now: number) {
  if (!(quote.bid > 0) || !(quote.ask > 0)) return "non-positive price";
  if (quote.ask < quote.bid) return "crossed quote";
  if (!quote.tradeable) return "instrument not tradeable";
  const time = Date.parse(quote.time);
  if (!Number.isFinite(time)) return "quote has no time";
  if (now - time > NEWS_MAX_QUOTE_AGE_MS) return "stale quote";
  return null;
}

export type NewsTickDecision =
  | { kind: "hold" }
  | { kind: "before_release" }
  | { kind: "expired" }
  | { kind: "bad_quote"; reason: string }
  /** Both executable prices are past their entry edges but the mid is between them: a spread artefact. No order. */
  | { kind: "ambiguous"; spreadPips: number }
  | { kind: "spread_blocked"; side: NewsStraddleSide; spreadPips: number }
  /** First sighting is already beyond the zone's far edge: skipped, never chased. */
  | { kind: "jumped_past"; side: NewsStraddleSide; price: number; bound: number; spreadPips: number }
  | { kind: "fire"; side: NewsStraddleSide; price: number; bound: number; spreadPips: number };

/**
 * What one live quote means for a setup with locked zones. BUY uses the ask
 * against the BUY zone, SELL the bid against the SELL zone; both bounds are
 * inclusive. Nothing can fire before the release or after the window.
 */
export function decideNewsTick(input: {
  zones: NewsZones;
  quote: NewsQuote;
  now: number;
  releaseAt: number;
  expiresAt: number;
  pip: number;
  precision: number;
  spreadCapPips: number;
}): NewsTickDecision {
  if (input.now >= input.expiresAt) return { kind: "expired" };
  if (input.now < input.releaseAt) return { kind: "before_release" };
  const problem = quoteProblem(input.quote, input.now);
  if (problem) return { kind: "bad_quote", reason: problem };
  const p = input.precision;
  const bid = steps(input.quote.bid, p), ask = steps(input.quote.ask, p);
  const buyLower = steps(input.zones.buy.lower, p), buyUpper = steps(input.zones.buy.upper, p);
  const sellLower = steps(input.zones.sell.lower, p), sellUpper = steps(input.zones.sell.upper, p);
  const longHit = ask >= buyLower;
  const shortHit = bid <= sellUpper;
  if (!longHit && !shortHit) return { kind: "hold" };
  const pipSteps = Math.round(input.pip * 10 ** p);
  const spreadPips = (ask - bid) / pipSteps;
  let side: NewsStraddleSide;
  if (longHit && shortHit) {
    const midTwice = bid + ask;
    if (midTwice >= 2 * buyLower) side = "long";
    else if (midTwice <= 2 * sellUpper) side = "short";
    else return { kind: "ambiguous", spreadPips };
  } else {
    side = longHit ? "long" : "short";
  }
  const price = side === "long" ? input.quote.ask : input.quote.bid;
  const bound = side === "long" ? input.zones.buy.upper : input.zones.sell.lower;
  const beyond = side === "long" ? ask > buyUpper : bid < sellLower;
  if (beyond) return { kind: "jumped_past", side, price, bound, spreadPips };
  if (ask - bid > Math.round(input.spreadCapPips * pipSteps)) return { kind: "spread_blocked", side, spreadPips };
  return { kind: "fire", side, price, bound, spreadPips };
}

/** Pips the fill landed past `reference`: positive is worse for the trade. */
export function newsSlippagePips(side: NewsStraddleSide, reference: number, fill: number, pip: number) {
  return Number((((side === "long" ? fill - reference : reference - fill) / pip)).toFixed(1));
}

/** Stop and target placed from the broker's actual fill. */
export function levelsFromFill(instrument: string, side: NewsStraddleSide, fill: number, stopPips: number, targetPips: number) {
  const pip = pipSizeFor(instrument);
  const r = (value: number) => Number(value.toFixed(precisionFor(instrument)));
  return side === "long"
    ? { stop: r(fill - stopPips * pip), target: r(fill + targetPips * pip) }
    : { stop: r(fill + stopPips * pip), target: r(fill - targetPips * pip) };
}

/** Why a filled trade closed, read from where it closed relative to its stop and target. */
export function exitReasonOf(side: NewsStraddleSide, exit: number, stop: number | null, target: number | null, pip: number): "stop" | "target" | "manual" {
  const half = pip / 2;
  if (side === "long") {
    if (stop !== null && exit <= stop + half) return "stop";
    if (target !== null && exit >= target - half) return "target";
  } else {
    if (stop !== null && exit >= stop - half) return "stop";
    if (target !== null && exit <= target + half) return "target";
  }
  return "manual";
}

function numberIn(raw: unknown, fallback: number | null, min: number, max: number, label: string) {
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === null) throw new Error(`Enter ${label}.`);
    return fallback;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} must be between ${min} and ${max}.`);
  return value;
}

/** Validate the ticket's News-mode fields. There is no anchor: it is always the live price at lock. */
export function parseNewsStraddleSettings(payload: Record<string, unknown>): NewsStraddleSettings {
  const rawRelease = payload.release && typeof payload.release === "object" ? payload.release as Record<string, unknown> : null;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const releaseTime = text(rawRelease?.time, 40);
  const title = text(rawRelease?.title, 120);
  if (!rawRelease || !title || !releaseTime || !Number.isFinite(Date.parse(releaseTime))) {
    throw new Error("Pick the release this setup is for. News mode only arms around a release.");
  }
  return {
    distancePips: numberIn(payload.distancePips, 10, 1, 200, "the zone distance in pips"),
    stopPips: numberIn(payload.stopPips, null, 1, 500, "a stop in pips"),
    targetPips: numberIn(payload.targetPips, null, 1, 1000, "a target in pips"),
    slippagePips: numberIn(payload.slippagePips, 3, 0.5, 20, "the zone depth in pips"),
    spreadCapPips: numberIn(payload.spreadCapPips, 8, 0.5, 50, "the spread cap in pips"),
    armedMinutes: Math.round(numberIn(payload.armedMinutes, 15, 1, 240, "how long it watches after the release (minutes)")),
    closeAfterMinutes: Math.round(numberIn(payload.closeAfterMinutes, 15, 0, 240, "the time exit (minutes)")),
    release: { id: text(rawRelease.id, 120), title, currency: text(rawRelease.currency, 3), time: new Date(releaseTime).toISOString() },
  };
}

/** Releases for either currency of the pair inside the look-ahead, soonest first. */
export function upcomingPairReleases<T extends { currency: string; timestamp: string }>(instrument: string, events: T[], now: number) {
  const { base, quote } = currenciesOf(instrument);
  return events
    .filter((event) => event.currency === base || event.currency === quote)
    .filter((event) => {
      const time = Date.parse(event.timestamp);
      return time > now && time <= now + NEWS_LOOKAHEAD_MS;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

// ── Persistence: compare-and-set transitions with a timeline ──────────

const metaOf = (row: PendingEntryRow) => (row.metadata ?? {}) as unknown as NewsMeta;
const fmt = (instrument: string, value: number) => value.toFixed(precisionFor(instrument));
const releaseLabel = (release: NewsStraddleSettings["release"]) => `${release.currency ? `${release.currency} ` : ""}${release.title}`;
const clockText = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const lockKey = (straddleId: string) => `news-straddle:${straddleId}`;

async function lockRows(client: Queryable, straddleId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(straddleId)]);
  const rows = (await client.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 FOR UPDATE`,
    [straddleId],
  )).rows;
  const upper = rows.find((row) => metaOf(row).line === "upper");
  const lower = rows.find((row) => metaOf(row).line === "lower");
  return upper && lower ? { upper, lower, state: metaOf(upper).newsState } : null;
}

/**
 * Move a setup from one of `from` to `to` on both rows, merging `patch` into
 * their metadata and appending a timeline entry. Returns false (and changes
 * nothing) when the setup is no longer in an allowed state: a repeat or a
 * lost race is a no-op, never a second transition.
 */
async function transition(client: Queryable, straddleId: string, from: NewsState[], to: NewsState, now: number, detail: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) {
  for (const state of from) if (!canTransition(state, to)) throw new Error(`news setup: ${state} → ${to} is not an allowed transition`);
  const at = new Date(now).toISOString();
  const result = await client.query(
    `UPDATE pending_manual_entries
        SET metadata = metadata || $3::jsonb
              || jsonb_build_object('newsState', $4::text, 'newsStateAt', $5::text,
                   'timeline', COALESCE(metadata->'timeline','[]'::jsonb) || jsonb_build_array(jsonb_build_object('at',$5::text,'from',metadata->>'newsState','to',$4::text) || $6::jsonb)),
            updated_at = now()
      WHERE metadata->>'straddleId'=$1 AND metadata->>'newsState' = ANY($2::text[])`,
    [straddleId, from, JSON.stringify(patch), to, at, JSON.stringify(detail)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Append a timeline note without changing state (spread waits, unverified calendar, lock retries). */
async function note(client: Queryable, straddleId: string, now: number, detail: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  await client.query(
    `UPDATE pending_manual_entries
        SET metadata = metadata || $2::jsonb || jsonb_build_object('timeline', COALESCE(metadata->'timeline','[]'::jsonb) || jsonb_build_array(jsonb_build_object('at',$3::text) || $4::jsonb))
      WHERE metadata->>'straddleId'=$1`,
    [straddleId, JSON.stringify(patch), new Date(now).toISOString(), JSON.stringify(detail)],
  );
}

/** Set both rows' row-level status to match a setup state (kept for the journal, pickers and older readers). */
async function setRowStatus(client: Queryable, id: string, status: string, extra: { failureReason?: string; cancelled?: boolean } = {}) {
  await client.query(
    `UPDATE pending_manual_entries SET status=$2, failure_reason=COALESCE($3,failure_reason),
       cancelled_at=CASE WHEN $4 THEN now() ELSE cancelled_at END, updated_at=now() WHERE id=$1`,
    [id, status, extra.failureReason ?? null, extra.cancelled === true],
  );
}

type Publish = { row: PendingEntryRow; event: NewsEvent; title: string; message: string; key?: string; detail?: Record<string, unknown> };

/** Log every event; notify (idempotently, by setup + event) unless it is a quiet one. */
async function publish(item: Publish, deps: NewsDeps) {
  const meta = metaOf(item.row);
  deps.log({ event: item.event, setupId: meta.straddleId, instrument: item.row.instrument, at: new Date(deps.now()).toISOString(), ...item.detail });
  if (QUIET_EVENTS.has(item.event)) return;
  await deps.notify({ userId: item.row.user_id, instrument: item.row.instrument, key: item.key ?? meta.straddleId, event: item.event, title: item.title, message: item.message });
}

// ── Safety checks ──────────────────────────────────────────────────────

const PAIR_BUSY_SQL = `CASE
       WHEN EXISTS (SELECT 1 FROM paper_strategy_trades WHERE user_id=$1 AND instrument=$2 AND status='open')
         OR EXISTS (SELECT 1 FROM paper_trades WHERE user_id=$1 AND pair=$3 AND status='open') THEN 'open'
       WHEN EXISTS (SELECT 1 FROM pending_manual_entries WHERE user_id=$1 AND instrument=$2 AND status IN ('PENDING','TRIGGERING')
                      AND COALESCE(metadata->>'straddleId','') <> COALESCE($4::text,'')) THEN 'pending'
       ELSE NULL END`;

/** Kill switch, max risk and one-trade-per-pair in one round trip. */
async function safetyChecks(db: Queryable, userId: string, instrument: string, straddleId: string | null) {
  const row = (await db.query<{ kill_switch: boolean | null; max_risk: string | null; busy: string | null }>(
    `SELECT (SELECT kill_switch FROM trade_plan_risk_settings WHERE user_id=$1) AS kill_switch,
            (SELECT max_risk_percent::text FROM trade_plan_risk_settings WHERE user_id=$1) AS max_risk,
            ${PAIR_BUSY_SQL} AS busy`,
    [userId, instrument, instrument.replace("_", "/"), straddleId],
  )).rows[0];
  return { killSwitch: row?.kill_switch === true, maxRiskPercent: row?.max_risk == null ? null : Number(row.max_risk), busy: row?.busy ?? null };
}

// ── Arming ────────────────────────────────────────────────────────────

export async function armNewsStraddle(userId: string, payload: Record<string, unknown>, tick: MarketPriceTick, deps: NewsDeps = liveNewsDeps) {
  const now = deps.now();
  const problem = quoteProblem({ bid: tick.bid, ask: tick.ask, time: tick.time, tradeable: true }, now);
  if (tick.source !== "oanda" || problem) throw new Error("A fresh, valid OANDA quote is required to arm a news setup.");
  if (payload.instrument !== tick.instrument) throw new Error("The selected instrument does not match the live quote.");
  if (deps.broker.environment() !== "practice") throw new Error("News mode only trades the OANDA practice account.");
  const instrument = tick.instrument;
  const pip = pipSizeFor(instrument);
  const precision = precisionFor(instrument);
  const settings = parseNewsStraddleSettings(payload);
  const requested = settings.release;
  const releaseAt = Date.parse(requested.time);
  // A release for this pair in the next 5 hours, confirmed by the server's own calendar.
  const events = await deps.releases();
  if (!events) throw new Error("The economic calendar can't be read right now, so the release can't be confirmed. Try again shortly.");
  const ahead = upcomingPairReleases(instrument, events, now);
  const { base: baseCurrency, quote: quoteCurrency } = currenciesOf(instrument);
  if (!ahead.length) throw new Error(`No ${baseCurrency} or ${quoteCurrency} news in the next 5 hours. News mode only arms ahead of a release.`);
  const match = ahead.find((event) => Math.abs(Date.parse(event.timestamp) - releaseAt) < 60_000 && (!requested.currency || event.currency === requested.currency));
  if (!match) throw new Error("That release is not in the calendar for the next 5 hours. Pick it again from the list.");
  // The calendar's own wording and time are what the lock re-checks against.
  const release = { id: requested.id, title: match.title, currency: match.currency, time: new Date(Date.parse(match.timestamp)).toISOString() };
  const verifiedReleaseAt = Date.parse(release.time);
  const safety = await safetyChecks(deps.db, userId, instrument, null);
  if (safety.killSwitch) throw new Error("The execution kill switch is on (Settings). Turn it off to arm a news setup.");
  if (safety.busy) throw new Error(safety.busy === "open"
    ? "This pair already has an open trade. News mode opens one trade per pair, so close it first."
    : "This pair already has a waiting entry. Cancel it first; News mode holds one trade per pair.");
  const lockAt = verifiedReleaseAt - NEWS_LOCK_LEAD_MS;
  const preview = newsZones(instrument, (tick.bid + tick.ask) / 2, settings.distancePips, settings.slippagePips);
  // Both sides carry the same stop distance, so one size fits either side.
  const sized = await deps.size(userId, instrument, preview.buy.lower, preview.buy.lower - settings.stopPips * pip);
  if (safety.maxRiskPercent !== null && sized.riskPercent > safety.maxRiskPercent + 1e-9) {
    throw new Error(`Your risk per trade (${sized.riskPercent}%) is above the max risk limit (${safety.maxRiskPercent}%) in Settings.`);
  }
  const straddleId = randomUUID();
  const expiresAt = new Date(verifiedReleaseAt + settings.armedMinutes * 60_000).toISOString();
  const at = new Date(now).toISOString();
  const base: NewsMeta & Record<string, unknown> = {
    mode: "news", straddleId, line: "upper", newsState: "ARMED", configVersion: NEWS_CONFIG_VERSION, createdFrom: "chart", tradeStyle: "day",
    distancePips: settings.distancePips, stopPips: settings.stopPips, targetPips: settings.targetPips,
    slippagePips: settings.slippagePips, spreadCapPips: settings.spreadCapPips, closeAfterMinutes: settings.closeAfterMinutes,
    armedMinutes: settings.armedMinutes, units: sized.units, riskPercent: sized.riskPercent, release,
    lockAt: new Date(lockAt).toISOString(), pipSize: pip, precision, zones: null, anchor: null, lockedAt: null, reservation: null,
    spreadAtArmPips: Number(((tick.ask - tick.bid) / pip).toFixed(1)),
    timeline: [{ at, to: "ARMED", release, settings: { ...settings, release: undefined }, units: sized.units, riskPercent: sized.riskPercent }],
  };
  const rows = await deps.db.tx(async (client) => {
    await client.query(
      "INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING",
      [instrument, displayPair(instrument), precision],
    );
    const inserted: PendingEntryRow[] = [];
    // entry_price holds the preview entry edge until the lock writes the real one.
    for (const [direction, line, price, orderType] of [["long", "upper", preview.buy.lower, "buy_stop"], ["short", "lower", preview.sell.upper, "sell_stop"]] as const) {
      const result = await client.query<PendingEntryRow>(
        `INSERT INTO pending_manual_entries(user_id,instrument,direction,entry_price,entry_order_type,current_price_at_creation,
           expiration_type,expires_at,activate_at,last_observed_price,last_observed_at,metadata)
         VALUES($1,$2,$3,$4,$5,$6,'time',$7,$8,$6,$9,$10::jsonb) RETURNING ${PENDING_ENTRY_FIELDS}`,
        [userId, instrument, direction, price, orderType, Number(((tick.bid + tick.ask) / 2).toFixed(precision)), expiresAt, new Date(lockAt).toISOString(), tick.time, JSON.stringify({ ...base, line })],
      );
      inserted.push(result.rows[0]!);
    }
    return inserted;
  });
  rememberSetup(rows[0]!, rows[1]!);
  await publish({
    row: rows[0]!, event: "news_setup_armed",
    title: `${displayPair(instrument)} news setup armed for ${releaseLabel(release)}`,
    message: `Release at ${clockText(release.time)}. At ${clockText(new Date(lockAt).toISOString())} GX takes the live price as the anchor and freezes a BUY zone ${settings.distancePips}–${settings.distancePips + settings.slippagePips} pips above and a SELL zone the same below. `
      + `Entries open at the release. Stop ${settings.stopPips}p, target ${settings.targetPips}p from the fill, spread cap ${settings.spreadCapPips}p, watches until ${clockText(expiresAt)}. Spread now ${base.spreadAtArmPips} pips.`,
  }, deps);
  // A release under a minute away locks straight away.
  if (now >= lockAt) await lockZones(straddleId, tick, deps);
  return (await readSetupRows(deps.db, straddleId)).map(serializePendingManualEntry);
}

async function readSetupRows(db: Queryable, straddleId: string) {
  return (await db.query<PendingEntryRow>(`SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 ORDER BY direction`, [straddleId])).rows;
}

// ── In-memory watch list ───────────────────────────────────────────────

/**
 * Live setups held in memory so an ordinary tick costs no database work. A
 * tick that is due to lock, start the watch, enter a zone or end the window
 * goes to a locked transaction that decides again from the database. The
 * sweep reloads this every 5 seconds and at startup; the database stays the
 * only authority.
 */
type CachedSetup = {
  straddleId: string;
  instrument: string;
  state: NewsState;
  zones: NewsZones | null;
  lockAt: number;
  releaseAt: number;
  expiresAt: number;
  spreadCapPips: number;
};
const live = new Map<string, Map<string, CachedSetup>>();

function rememberSetup(first: PendingEntryRow, second: PendingEntryRow) {
  const meta = metaOf(first);
  const byInstrument = live.get(first.instrument) ?? new Map<string, CachedSetup>();
  if (!LIVE_STATES.includes(meta.newsState) || first.status !== "PENDING" || second.status !== "PENDING") {
    byInstrument.delete(meta.straddleId);
    return;
  }
  byInstrument.set(meta.straddleId, {
    straddleId: meta.straddleId,
    instrument: first.instrument,
    state: meta.newsState,
    zones: meta.zones ?? null,
    lockAt: Date.parse(meta.lockAt),
    releaseAt: Date.parse(meta.release.time),
    expiresAt: first.expires_at ? Date.parse(first.expires_at) : Number.POSITIVE_INFINITY,
    spreadCapPips: meta.spreadCapPips,
  });
  live.set(first.instrument, byInstrument);
}

function forgetSetup(instrument: string, straddleId: string) {
  live.get(instrument)?.delete(straddleId);
}

async function refreshOne(straddleId: string, deps: NewsDeps) {
  const rows = await readSetupRows(deps.db, straddleId);
  if (rows.length === 2) rememberSetup(rows[0]!, rows[1]!);
  else if (rows[0]) forgetSetup(rows[0].instrument, straddleId);
}

/** Reload the watch list from the database (startup and every sweep). */
export async function refreshArmedNewsStraddles(deps: NewsDeps = liveNewsDeps) {
  const rows = (await deps.db.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries
      WHERE status='PENDING' AND metadata->>'mode'='news' AND metadata->>'newsState' = ANY($1::text[])`,
    [LIVE_STATES],
  )).rows;
  live.clear();
  const groups = new Map<string, PendingEntryRow[]>();
  for (const row of rows) groups.set(metaOf(row).straddleId, [...(groups.get(metaOf(row).straddleId) ?? []), row]);
  for (const group of groups.values()) if (group.length === 2) rememberSetup(group[0]!, group[1]!);
  return groups.size;
}

/** Cheap gate for the per-tick hook. */
export function newsStraddleMayBeArmed(instrument: string) {
  return (live.get(instrument)?.size ?? 0) > 0;
}

// ── Lock: anchor and frozen zones, 60 s before the release ─────────────

/**
 * Freeze a setup's zones from a fresh quote, between lock time and the
 * release. A stale or unusable quote is never substituted: the setup moves to
 * LOCKING and retries on the next tick or sweep, and if the release arrives
 * with no valid anchor it is SKIPPED. Before freezing, the release is
 * re-checked against the calendar: moved or withdrawn → SKIPPED; calendar
 * unreadable → locked, with that noted.
 */
async function lockZones(straddleId: string, tick: MarketPriceTick, deps: NewsDeps) {
  const now = deps.now();
  const quote = { bid: tick.bid, ask: tick.ask, time: tick.time, tradeable: tick.status === undefined || String(tick.status).toLowerCase() === "tradeable" };
  const events = await deps.releases().catch(() => null);
  const out = await deps.db.tx(async (client) => {
    const setup = await lockRows(client, straddleId);
    if (!setup || !["ARMED", "LOCKING"].includes(setup.state)) return null;
    const meta = metaOf(setup.upper);
    const instrument = setup.upper.instrument;
    const releaseAt = Date.parse(meta.release.time);
    const lockAt = Date.parse(meta.lockAt);
    if (now < lockAt) return null;
    if (now >= releaseAt) {
      await transition(client, straddleId, [setup.state], "SKIPPED", now, { reason: "no valid anchor before the release" });
      for (const row of [setup.upper, setup.lower]) await setRowStatus(client, row.id, "FAILED", { failureReason: "Skipped: no valid price to lock the zones before the release." });
      return { event: "news_setup_skipped" as const, row: setup.upper, message: "No valid OANDA price arrived to lock the zones before the release, so nothing was set up. No order was sent." };
    }
    const safety = await safetyChecks(client, setup.upper.user_id, instrument, straddleId);
    if (safety.killSwitch) {
      await transition(client, straddleId, [setup.state], "SKIPPED", now, { reason: "kill switch on at lock" });
      for (const row of [setup.upper, setup.lower]) await setRowStatus(client, row.id, "FAILED", { failureReason: "Skipped: the kill switch was on at lock time." });
      return { event: "news_setup_skipped" as const, row: setup.upper, message: "The execution kill switch was on at lock time, so the setup was skipped. No order was sent." };
    }
    if (events) {
      const same = events.filter((event) => event.currency === meta.release.currency && event.title === meta.release.title);
      const onTime = same.find((event) => Math.abs(Date.parse(event.timestamp) - releaseAt) < 60_000);
      if (!onTime) {
        const moved = same.map((event) => event.timestamp).filter((time) => Math.abs(Date.parse(time) - releaseAt) < 48 * 60 * 60_000).sort()[0];
        const reason = moved ? `the release moved to ${clockText(moved)}` : "the release is no longer in the calendar";
        await transition(client, straddleId, [setup.state], "SKIPPED", now, { reason, calendarRelease: moved ?? null });
        for (const row of [setup.upper, setup.lower]) await setRowStatus(client, row.id, "FAILED", { failureReason: `Skipped: ${reason}.` });
        return { event: "news_setup_skipped" as const, row: setup.upper, message: `${reason[0]!.toUpperCase()}${reason.slice(1)}, so the setup was skipped rather than trade on old timing. Arm it again for the new time. No order was sent.` };
      }
    }
    const problem = quoteProblem(quote, now);
    if (problem) {
      if (setup.state === "ARMED") await transition(client, straddleId, ["ARMED"], "LOCKING", now, { reason: problem, quoteTime: tick.time });
      else await note(client, straddleId, now, { note: "lock retry", reason: problem, quoteTime: tick.time });
      return null;
    }
    const anchorMid = Number(((tick.bid + tick.ask) / 2).toFixed(meta.precision));
    const zones = newsZones(instrument, anchorMid, meta.distancePips, meta.slippagePips);
    const lockedAt = new Date(now).toISOString();
    const moved = await transition(client, straddleId, [setup.state], "ZONES_LOCKED", now, {
      anchor: { bid: tick.bid, ask: tick.ask, mid: anchorMid, convention: "mid", quoteTime: tick.time }, zones,
      calendarVerified: Boolean(events),
    }, {
      zones, anchor: anchorMid, anchorBid: tick.bid, anchorAsk: tick.ask, anchorQuoteTime: tick.time, anchorConvention: "mid", lockedAt,
      calendarVerifiedAtLock: Boolean(events),
      // Kept for older readers: entry edges and far edges.
      upperLine: zones.buy.lower, upperFar: zones.buy.upper, lowerLine: zones.sell.upper, lowerFar: zones.sell.lower,
    });
    if (!moved) return null;
    await client.query("UPDATE pending_manual_entries SET entry_price=$2,current_price_at_creation=$3,last_observed_price=$3,last_observed_at=$4 WHERE id=$1", [setup.upper.id, zones.buy.lower, anchorMid, tick.time]);
    await client.query("UPDATE pending_manual_entries SET entry_price=$2,current_price_at_creation=$3,last_observed_price=$3,last_observed_at=$4 WHERE id=$1", [setup.lower.id, zones.sell.upper, anchorMid, tick.time]);
    return {
      event: "news_zones_locked" as const, row: setup.upper,
      message: `Anchor ${fmt(instrument, anchorMid)} (live mid at ${clockText(lockedAt)}). BUY zone ${fmt(instrument, zones.buy.lower)}–${fmt(instrument, zones.buy.upper)} (ask), SELL zone ${fmt(instrument, zones.sell.lower)}–${fmt(instrument, zones.sell.upper)} (bid). `
        + `Spread ${((tick.ask - tick.bid) / meta.pipSize).toFixed(1)} pips. Entries open at ${clockText(meta.release.time)}${events ? "" : "; the calendar could not be re-checked at lock, so the stored release time is used"}.`,
    };
  });
  await refreshOne(straddleId, deps);
  if (out) await publish({ row: out.row, event: out.event, title: `${displayPair(out.row.instrument)} news ${out.event === "news_zones_locked" ? "zones locked" : "setup skipped"}`, message: out.message }, deps);
}

/** ZONES_LOCKED → WATCHING once the release time has arrived (kill switch re-checked). */
async function startWatch(straddleId: string, deps: NewsDeps) {
  const now = deps.now();
  const out = await deps.db.tx(async (client) => {
    const setup = await lockRows(client, straddleId);
    if (!setup || setup.state !== "ZONES_LOCKED") return null;
    const meta = metaOf(setup.upper);
    if (now < Date.parse(meta.release.time)) return null;
    const safety = await safetyChecks(client, setup.upper.user_id, setup.upper.instrument, straddleId);
    if (safety.killSwitch) {
      await transition(client, straddleId, ["ZONES_LOCKED"], "SKIPPED", now, { reason: "kill switch on at release" });
      for (const row of [setup.upper, setup.lower]) await setRowStatus(client, row.id, "FAILED", { failureReason: "Skipped: the kill switch was on at the release." });
      return { event: "news_setup_skipped" as const, row: setup.upper, message: "The execution kill switch was on at the release, so no entries were watched. No order was sent." };
    }
    await transition(client, straddleId, ["ZONES_LOCKED"], "WATCHING", now, {});
    return { event: "news_watch_started" as const, row: setup.upper, message: `${releaseLabel(meta.release)} is out. Watching both zones until ${clockText(setup.upper.expires_at!)}.` };
  });
  await refreshOne(straddleId, deps);
  if (out) await publish({ row: out.row, event: out.event, title: `${displayPair(out.row.instrument)} news ${out.event === "news_watch_started" ? "watch started" : "setup skipped"}`, message: out.message }, deps);
}

// ── Trigger: reserve one side atomically ───────────────────────────────

type Reserved = { row: PendingEntryRow; attemptId: string; clientRequestId: string; bound: number; triggerPrice: number; tickTime: number };

/**
 * Decide again inside the locked transaction and, for a zone touch, reserve
 * that side: the winner row goes TRIGGERING, the other CANCELLED, the setup
 * TRIGGER_RESERVED with a fresh attempt id — all in one commit, so a second
 * tick, worker or process finds the setup no longer WATCHING and does nothing.
 */
async function settleTick(straddleId: string, tick: MarketPriceTick, deps: NewsDeps): Promise<Reserved | null> {
  const now = deps.now();
  const quote = { bid: tick.bid, ask: tick.ask, time: tick.time, tradeable: tick.status === undefined || String(tick.status).toLowerCase() === "tradeable" };
  const out = await deps.db.tx(async (client): Promise<{ publish?: Publish; reserved?: Reserved } | null> => {
    const setup = await lockRows(client, straddleId);
    if (!setup || setup.state !== "WATCHING") return null;
    const meta = metaOf(setup.upper);
    const instrument = setup.upper.instrument;
    const pair = displayPair(instrument);
    const decision = decideNewsTick({
      zones: meta.zones!, quote, now, releaseAt: Date.parse(meta.release.time), expiresAt: Date.parse(setup.upper.expires_at!),
      pip: meta.pipSize, precision: meta.precision, spreadCapPips: meta.spreadCapPips,
    });
    if (decision.kind === "hold" || decision.kind === "before_release" || decision.kind === "bad_quote" || decision.kind === "ambiguous") return null;
    if (decision.kind === "expired") {
      await transition(client, straddleId, ["WATCHING"], "EXPIRED", now, {});
      for (const row of [setup.upper, setup.lower]) await setRowStatus(client, row.id, "EXPIRED");
      return { publish: { row: setup.upper, event: "news_setup_expired", title: `${pair} news setup expired`, message: "Price did not enter either zone before the watch window ended. No order was sent." } };
    }
    if (decision.kind === "spread_blocked") {
      if (meta.spreadBlockedAt) return null;
      await note(client, straddleId, now, { note: "spread over cap", side: decision.side, spreadPips: decision.spreadPips, bid: tick.bid, ask: tick.ask }, { spreadBlockedAt: new Date(now).toISOString() });
      return { publish: { row: setup.upper, event: "news_spread_blocked", title: `${pair} news zone reached — spread too wide`, message: `The ${decision.side === "long" ? "BUY" : "SELL"} zone was reached with a ${decision.spreadPips.toFixed(1)}-pip spread, above your ${meta.spreadCapPips}-pip cap. No order yet; it sends one if price is still inside the zone once the spread is back under the cap.` } };
    }
    const winner = decision.side === "long" ? setup.upper : setup.lower;
    const loser = decision.side === "long" ? setup.lower : setup.upper;
    const sideWord = decision.side === "long" ? "BUY" : "SELL";
    const quoteDetail = { bid: tick.bid, ask: tick.ask, quoteTime: tick.time, spreadPips: Number(decision.spreadPips.toFixed(1)) };
    const safety = await safetyChecks(client, winner.user_id, instrument, straddleId);
    const blocked = safety.killSwitch ? "the execution kill switch is on"
      : deps.broker.environment() !== "practice" ? "the broker account is not the OANDA practice account"
        : safety.busy ? `this pair already has ${safety.busy === "open" ? "an open trade" : "another waiting entry"}`
          : safety.maxRiskPercent !== null && meta.riskPercent > safety.maxRiskPercent + 1e-9 ? `the risk (${meta.riskPercent}%) is above the max risk limit (${safety.maxRiskPercent}%)`
            : null;
    if (blocked || decision.kind === "jumped_past") {
      const reason = blocked
        ? `${sideWord} zone reached but ${blocked}`
        : `${decision.side === "long" ? "ask" : "bid"} ${fmt(instrument, decision.price)} was already past the ${sideWord} zone's far edge ${fmt(instrument, decision.bound)}; not chased`;
      await transition(client, straddleId, ["WATCHING"], "SKIPPED", now, { reason, side: decision.side, ...quoteDetail });
      await setRowStatus(client, winner.id, "FAILED", { failureReason: `Skipped: ${reason}.` });
      await setRowStatus(client, loser.id, "CANCELLED", { cancelled: true });
      return { publish: { row: winner, event: "news_setup_skipped", title: `${pair} news setup skipped`, message: `${reason[0]!.toUpperCase()}${reason.slice(1)}. Spread ${decision.spreadPips.toFixed(1)} pips. No order was sent; both zones are off.` } };
    }
    const attemptId = randomUUID();
    const clientRequestId = `news-${attemptId}`;
    const reservation = {
      attemptId, side: decision.side, clientRequestId, priceBound: decision.bound,
      triggerBid: tick.bid, triggerAsk: tick.ask, triggerQuoteTime: tick.time, spreadPips: Number(decision.spreadPips.toFixed(1)), reservedAt: new Date(now).toISOString(),
    };
    const moved = await transition(client, straddleId, ["WATCHING"], "TRIGGER_RESERVED", now, { side: decision.side, attemptId, priceBound: decision.bound, ...quoteDetail }, { reservation });
    if (!moved) return null;
    await client.query(
      `UPDATE pending_manual_entries SET status='TRIGGERING', trigger_price=$2, triggered_at=$3, last_observed_price=$2, last_observed_at=$3 WHERE id=$1`,
      [winner.id, decision.price, new Date(Date.parse(tick.time))],
    );
    await setRowStatus(client, loser.id, "CANCELLED", { cancelled: true });
    const row = (await client.query<PendingEntryRow>(`SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE id=$1`, [winner.id])).rows[0]!;
    return {
      reserved: { row, attemptId, clientRequestId, bound: decision.bound, triggerPrice: decision.price, tickTime: Date.parse(tick.time) },
      publish: { row, event: "news_zone_triggered", title: `${pair} ${sideWord} zone triggered`, message: `${sideWord} at ${fmt(instrument, decision.price)}`, detail: { side: decision.side, attemptId, ...quoteDetail } },
    };
  });
  if (out?.publish) await publish(out.publish, deps);
  return out?.reserved ?? null;
}

/** Run this instrument's live setups against a quote: lock, start watching, or trigger. */
export async function evaluateNewsStraddles(tick: MarketPriceTick, deps: NewsDeps = liveNewsDeps) {
  const setups = [...(live.get(tick.instrument)?.values() ?? [])];
  if (!setups.length) return { fired: 0 };
  const now = deps.now();
  let fired = 0;
  for (const setup of setups) {
    if (setup.state === "ARMED" || setup.state === "LOCKING") {
      if (now >= setup.lockAt) await lockZones(setup.straddleId, tick, deps);
      continue;
    }
    if (setup.state === "ZONES_LOCKED") {
      if (now < setup.releaseAt) continue;
      await startWatch(setup.straddleId, deps);
    }
    const current = live.get(tick.instrument)?.get(setup.straddleId);
    if (!current || current.state !== "WATCHING" || !current.zones) continue;
    const quick = decideNewsTick({
      zones: current.zones, quote: { bid: tick.bid, ask: tick.ask, time: tick.time, tradeable: tick.status === undefined || String(tick.status).toLowerCase() === "tradeable" },
      now, releaseAt: current.releaseAt, expiresAt: current.expiresAt, pip: pipSizeFor(tick.instrument), precision: precisionFor(tick.instrument), spreadCapPips: current.spreadCapPips,
    });
    if (quick.kind === "hold" || quick.kind === "before_release" || quick.kind === "bad_quote" || quick.kind === "ambiguous") continue;
    const reserved = await settleTick(setup.straddleId, tick, deps);
    if (reserved) {
      // Off the watch list before the request, so no later tick reaches the database.
      forgetSetup(tick.instrument, setup.straddleId);
      fired += 1;
      await submitReserved(reserved, deps);
      continue;
    }
    await refreshOne(setup.straddleId, deps);
  }
  return { fired };
}

// ── Submit: one order per reservation ─────────────────────────────────

/** Friendly words for OANDA's cancel and reject reasons. */
function brokerReasonText(reason: string) {
  const known: Record<string, string> = {
    BOUNDS_VIOLATION: "price moved past the zone before OANDA could fill it (price bound); not chased",
    INSUFFICIENT_MARGIN: "not enough margin on the practice account",
    MARKET_HALTED: "the market was halted",
    INSUFFICIENT_LIQUIDITY: "OANDA had no liquidity at an acceptable price",
    UNITS_PRECISION_EXCEEDED: "the order size had too many decimals",
    PRICE_PRECISION_EXCEEDED: "a price had too many decimals",
  };
  return known[reason] ?? reason;
}

/**
 * Persist ORDER_SUBMITTING (the request, the client order id) before the
 * request goes out, then act only on what OANDA confirms. A timeout or 5xx
 * is ORDER_UNKNOWN and is looked up by client id later — never resent.
 */
async function submitReserved(reserved: Reserved, deps: NewsDeps) {
  const meta = metaOf(reserved.row);
  const instrument = reserved.row.instrument;
  const pair = displayPair(instrument);
  const side = reserved.row.direction;
  const sideWord = side === "long" ? "BUY" : "SELL";
  const straddleId = meta.straddleId;
  // Revalidate: the triggering quote must still be fresh when the order goes.
  if (deps.now() - reserved.tickTime > NEWS_MAX_QUOTE_AGE_MS) {
    const skipped = await deps.db.tx(async (client) => {
      const ok = await transition(client, straddleId, ["TRIGGER_RESERVED"], "SKIPPED", deps.now(), { reason: "triggering quote went stale before sending" });
      if (ok) await setRowStatus(client, reserved.row.id, "FAILED", { failureReason: "Skipped: the triggering quote went stale before the order could be sent." });
      return ok;
    });
    if (skipped) await publish({ row: reserved.row, event: "news_setup_skipped", title: `${pair} news setup skipped`, message: "The price that triggered the zone was more than 5 seconds old by the time the order could go, so nothing was sent. Not chased." }, deps);
    return;
  }
  const pip = meta.pipSize;
  const line = Number(reserved.row.entry_price);
  const provisionalTarget = Number((side === "long" ? line + meta.targetPips * pip : line - meta.targetPips * pip).toFixed(meta.precision));
  const request = {
    instrument, direction: side, units: meta.units, stopDistance: Number((meta.stopPips * pip).toFixed(meta.precision)), target: provisionalTarget,
    priceBound: reserved.bound, clientRequestId: reserved.clientRequestId, tradeClientId: `gxt-${reserved.clientRequestId}`,
  };
  const submittedAt = new Date(deps.now()).toISOString();
  const go = await deps.db.tx((client) => transition(client, straddleId, ["TRIGGER_RESERVED"], "ORDER_SUBMITTING", deps.now(), { request: { ...request, clientOrderId: `gx-${reserved.clientRequestId}` } }, { submittedAt }));
  if (!go) return; // someone else moved it (a sweep skipped an orphan): never send
  await publish({ row: reserved.row, event: "news_order_submitting", title: `${pair} ${sideWord} order sending`, message: "", detail: { attemptId: reserved.attemptId, priceBound: reserved.bound } }, deps);
  let result: Awaited<ReturnType<NewsDeps["broker"]["submit"]>>;
  try {
    result = await deps.broker.submit(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OANDA request failed.";
    const status = error instanceof OandaRequestError ? error.status : undefined;
    if (submitFailureKind(status) === "rejected") {
      await rejectInFlight(reserved.row, ["ORDER_SUBMITTING"], `OANDA refused the order (${message})`, { httpStatus: status }, deps);
    } else {
      const moved = await deps.db.tx((client) => transition(client, straddleId, ["ORDER_SUBMITTING"], "ORDER_UNKNOWN", deps.now(), { error: message.slice(0, 300), httpStatus: status ?? null }));
      if (moved) await publish({ row: reserved.row, event: "news_order_unknown", title: `${pair} ${sideWord} order unconfirmed`, message: "OANDA did not answer in time. The order may or may not have been received; GX is checking with OANDA by its order id and will not send another." }, deps);
    }
    return;
  }
  if (result.cancelReason || !result.tradeId || result.fillPrice === null) {
    const reason = result.cancelReason ? brokerReasonText(result.cancelReason) : "OANDA did not open a trade";
    await rejectInFlight(reserved.row, ["ORDER_SUBMITTING"], reason, { cancelReason: result.cancelReason, orderId: result.orderId }, deps);
    return;
  }
  await recordNewsFill(reserved.row, result.tradeId, result.fillPrice, result.fillSpread, result.orderId, deps);
}

async function rejectInFlight(row: PendingEntryRow, from: NewsState[], reason: string, detail: Record<string, unknown>, deps: NewsDeps) {
  const meta = metaOf(row);
  const moved = await deps.db.tx(async (client) => {
    const ok = await transition(client, meta.straddleId, from, "ORDER_REJECTED", deps.now(), { reason, ...detail });
    if (ok) await setRowStatus(client, row.id, "FAILED", { failureReason: `Not filled: ${reason}.` });
    return ok;
  });
  if (moved) {
    await publish({ row, event: "news_order_rejected", title: `${displayPair(row.instrument)} ${row.direction === "long" ? "BUY" : "SELL"} order not filled`, message: `Not filled: ${reason}. Nothing is open, and the other zone stays off.` }, deps);
  }
}

/**
 * Book a confirmed fill: move the target to fill ± target pips, read back the
 * protection OANDA actually holds, open the journal trade, start the time
 * exit from the fill. A fill without a confirmed stop is closed at once.
 */
async function recordNewsFill(row: PendingEntryRow, tradeId: string, fillPrice: number, fillSpread: number | null, orderId: string | null, deps: NewsDeps) {
  const meta = metaOf(row);
  const instrument = row.instrument;
  const pip = meta.pipSize;
  const side = row.direction;
  const pair = displayPair(instrument);
  const levels = levelsFromFill(instrument, side, fillPrice, meta.stopPips, meta.targetPips);
  let targetError: string | null = null;
  try {
    await deps.broker.setLevels(tradeId, instrument, { target: levels.target });
  } catch (error) {
    targetError = error instanceof Error ? error.message.slice(0, 200) : "target update failed";
  }
  const protection = await deps.broker.protection(tradeId).catch(() => null);
  const brokerStop = protection?.stopLoss ?? null;
  const brokerTarget = protection?.takeProfit ?? null;
  const triggerPrice = side === "long" ? meta.reservation?.triggerAsk ?? fillPrice : meta.reservation?.triggerBid ?? fillPrice;
  const slippageVsQuotePips = newsSlippagePips(side, triggerPrice, fillPrice, pip);
  const slippageVsEdgePips = newsSlippagePips(side, Number(row.entry_price), fillPrice, pip);
  const spreadAtFillPips = fillSpread !== null ? Number((fillSpread / pip).toFixed(1)) : null;
  const filledAt = new Date(deps.now()).toISOString();
  const timeExitAt = meta.closeAfterMinutes > 0 ? new Date(Date.parse(filledAt) + meta.closeAfterMinutes * 60_000).toISOString() : null;
  const fill = { brokerTradeId: tradeId, brokerOrderId: orderId, fillPrice, slippageVsQuotePips, slippagePips: slippageVsEdgePips, spreadAtFillPips, filledAt, timeExitAt, stopConfirmed: brokerStop, targetConfirmed: brokerTarget, targetError };
  const opened = await deps.db.tx(async (client) => {
    const moved = await transition(client, meta.straddleId, ["ORDER_SUBMITTING", "ORDER_UNKNOWN"], "FILLED", deps.now(), fill, fill);
    if (!moved) return null;
    const trade = await client.query<{ id: string }>(
      `INSERT INTO paper_trades(user_id,legacy_id,origin,pair,direction,status,result,opened_at,entry,stop,target,reason,notes)
       VALUES($1,$2,'manual',$3,$4,'open','open',$5,$6,$7,$8,'News breakout filled',$9)
       ON CONFLICT(user_id,legacy_id) DO UPDATE SET updated_at=paper_trades.updated_at RETURNING id`,
      [row.user_id, `pending-entry:${row.id}`, instrument.replace("_", "/"), side, filledAt, fillPrice, brokerStop ?? levels.stop, brokerTarget ?? levels.target,
        `News setup ${meta.straddleId}; zone edge ${row.entry_price}, fill ${fillPrice}, slippage ${slippageVsQuotePips} pips vs the triggering quote; OANDA trade ${tradeId}.`],
    );
    await client.query(
      `UPDATE pending_manual_entries SET status='TRIGGERED',trigger_price=$2,stop_price=$3,target_price=$4,paper_trade_id=$5,
         metadata=metadata||jsonb_build_object('execution','news_filled','brokerTradeId',$6::text),updated_at=now()
       WHERE id=$1`,
      [row.id, fillPrice, brokerStop, brokerTarget, trade.rows[0]!.id, tradeId],
    );
    return trade.rows[0]!.id;
  });
  if (!opened) return;
  if (brokerStop === null) {
    // The stop rides on the order, so OANDA should always confirm one. If it
    // does not, an unprotected news trade is closed straight away.
    let closed = false;
    try { await deps.broker.closeTrade(tradeId); closed = true; } catch (error) { deps.log({ event: "news_execution_error", setupId: meta.straddleId, error: String(error) }); }
    await deps.db.tx((client) => transition(client, meta.straddleId, ["FILLED"], "ERROR", deps.now(), { reason: "no stop confirmed by OANDA", closed }));
    await publish({ row, event: "news_execution_error", title: `URGENT: ${pair} news trade had no stop`, message: closed
      ? `OANDA did not confirm a stop on trade ${tradeId}, so GX closed it straight away.`
      : `OANDA did not confirm a stop on trade ${tradeId} and GX could not close it. Close it in OANDA now.` }, deps);
    return;
  }
  const spreadText = spreadAtFillPips !== null ? `${spreadAtFillPips} pips at fill` : `${meta.reservation?.spreadPips ?? "?"} pips at trigger`;
  await publish({
    row, event: "news_order_filled", title: `${pair} news ${side === "long" ? "BUY" : "SELL"} filled`,
    message: `${side === "long" ? "Bought" : "Sold"} at ${fmt(instrument, fillPrice)} (${slippageVsQuotePips >= 0 ? "+" : ""}${slippageVsQuotePips} pips vs the triggering ${side === "long" ? "ask" : "bid"}). Spread ${spreadText}. `
      + `Stop ${fmt(instrument, brokerStop)} confirmed by OANDA; target ${brokerTarget === null ? `not confirmed${targetError ? ` (${targetError})` : ""} — set it yourself` : `${fmt(instrument, brokerTarget)} confirmed`}. `
      + (timeExitAt ? `Closes at market at ${clockText(timeExitAt)} if neither hits.` : "No time exit."),
    detail: fill,
  }, deps);
}

// ── Sweep: recovery, reconciliation, time exits ────────────────────────

async function setupsIn(db: Queryable, states: NewsState[]) {
  const rows = (await db.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE metadata->>'mode'='news' AND metadata->>'newsState' = ANY($1::text[])`,
    [states],
  )).rows;
  const groups = new Map<string, PendingEntryRow[]>();
  for (const row of rows) groups.set(metaOf(row).straddleId, [...(groups.get(metaOf(row).straddleId) ?? []), row]);
  return [...groups.entries()].map(([straddleId, group]) => ({
    straddleId,
    upper: group.find((row) => metaOf(row).line === "upper") ?? group[0]!,
    // The side that went to the broker (TRIGGERING / TRIGGERED / FAILED), else the upper row.
    active: group.find((row) => ["TRIGGERING", "TRIGGERED"].includes(row.status)) ?? group.find((row) => row.status === "FAILED") ?? group[0]!,
  }));
}

/**
 * Runs every 5 seconds and at startup. Works with or without price ticks and
 * after a restart: locks due setups from a fetched quote, starts watches,
 * expires windows, ends reserved-but-unsent attempts, reconciles unknown
 * orders by client id, books stop/target closes, and runs time exits.
 */
export async function sweepNewsStraddles(deps: NewsDeps = liveNewsDeps) {
  const counts = { locked: 0, watching: 0, expired: 0, reconciled: 0, closed: 0, skipped: 0 };
  const now = deps.now();

  // Kill switch on before entry → skipped promptly, not only at the next stage.
  for (const setup of await setupsIn(deps.db, LIVE_STATES)) {
    const safety = await safetyChecks(deps.db, setup.upper.user_id, setup.upper.instrument, setup.straddleId);
    if (!safety.killSwitch) continue;
    const out = await deps.db.tx(async (client) => {
      const locked = await lockRows(client, setup.straddleId);
      if (!locked || !LIVE_STATES.includes(locked.state)) return false;
      const ok = await transition(client, setup.straddleId, [locked.state], "SKIPPED", now, { reason: "kill switch turned on" });
      for (const row of [locked.upper, locked.lower]) await setRowStatus(client, row.id, "FAILED", { failureReason: "Skipped: the kill switch was turned on." });
      return ok;
    });
    if (out) {
      counts.skipped += 1;
      await publish({ row: setup.upper, event: "news_setup_skipped", title: `${displayPair(setup.upper.instrument)} news setup skipped`, message: "The execution kill switch was turned on, so the setup was skipped. No order was sent." }, deps);
    }
  }

  // Lock due setups from a fetched quote when no stream tick came (bounded by the release).
  for (const setup of await setupsIn(deps.db, ["ARMED", "LOCKING"])) {
    const meta = metaOf(setup.upper);
    if (now < Date.parse(meta.lockAt)) continue;
    const tick = now < Date.parse(meta.release.time) ? await deps.quote(setup.upper.instrument).catch(() => null) : null;
    await lockZones(setup.straddleId, tick ?? { type: "price", instrument: setup.upper.instrument, displayName: "", bid: 0, ask: 0, mid: 0, spread: 0, status: "non-tradeable", time: new Date(0).toISOString(), source: "oanda", sequence: 0 }, deps);
    counts.locked += 1;
  }

  // Start watches whose release has come.
  for (const setup of await setupsIn(deps.db, ["ZONES_LOCKED"])) {
    if (now >= Date.parse(metaOf(setup.upper).release.time)) {
      await startWatch(setup.straddleId, deps);
      counts.watching += 1;
    }
  }

  // End watch windows that closed without a quote.
  for (const setup of await setupsIn(deps.db, ["WATCHING"])) {
    if (now < Date.parse(setup.upper.expires_at!)) continue;
    const out = await deps.db.tx(async (client) => {
      const locked = await lockRows(client, setup.straddleId);
      if (!locked || locked.state !== "WATCHING") return false;
      const ok = await transition(client, setup.straddleId, ["WATCHING"], "EXPIRED", now, {});
      for (const row of [locked.upper, locked.lower]) await setRowStatus(client, row.id, "EXPIRED");
      return ok;
    });
    if (out) {
      counts.expired += 1;
      await publish({ row: setup.upper, event: "news_setup_expired", title: `${displayPair(setup.upper.instrument)} news setup expired`, message: "Price did not enter either zone before the watch window ended. No order was sent." }, deps);
    }
  }

  // Reserved but never moved to ORDER_SUBMITTING: the request was certainly not sent (that state is written first).
  for (const setup of await setupsIn(deps.db, ["TRIGGER_RESERVED"])) {
    const reservedAt = Date.parse(metaOf(setup.active).reservation?.reservedAt ?? setup.active.updated_at);
    if (now - reservedAt < RESERVED_ORPHAN_MS) continue;
    const ok = await deps.db.tx(async (client) => {
      const moved = await transition(client, setup.straddleId, ["TRIGGER_RESERVED"], "SKIPPED", now, { reason: "reserved but not sent (interrupted); not chased" });
      if (moved) await setRowStatus(client, setup.active.id, "FAILED", { failureReason: "Skipped: interrupted before the order was sent; not chased." });
      return moved;
    });
    if (ok) {
      counts.skipped += 1;
      await publish({ row: setup.active, event: "news_setup_skipped", title: `${displayPair(setup.active.instrument)} news setup skipped`, message: "The server was interrupted after a zone was touched but before the order was sent. Nothing was sent, and GX does not chase the move." }, deps);
    }
  }

  // Unknown or long-pending submissions: ask OANDA by client order id. Never resend.
  for (const setup of await setupsIn(deps.db, ["ORDER_SUBMITTING", "ORDER_UNKNOWN"])) {
    const meta = metaOf(setup.active);
    if (!meta.reservation) continue;
    const submittedAt = Date.parse(meta.submittedAt ?? meta.reservation.reservedAt);
    if (now - submittedAt < RECONCILE_AFTER_MS) continue;
    const order = await deps.broker.orderByClientId(`gx-${meta.reservation.clientRequestId}`).catch(() => undefined);
    if (order === undefined) continue; // broker unreachable: try again next sweep
    const decision = reconcileDecision({ sinceUpdateMs: now - submittedAt, ageMs: now - submittedAt, order, reconcileAfterMs: RECONCILE_AFTER_MS, giveUpAfterMs: GIVE_UP_AFTER_MS });
    if (decision === "wait") continue;
    counts.reconciled += 1;
    const state = metaOf(setup.active).newsState;
    if (decision === "filled" && order?.tradeId) {
      const trade = await deps.broker.tradeState(order.tradeId).catch(() => null);
      await recordNewsFill(setup.active, order.tradeId, trade?.entryPrice ?? order.fillPrice ?? Number(setup.active.trigger_price), null, null, deps);
    } else if (decision === "rejected") {
      await rejectInFlight(setup.active, [state], "OANDA cancelled the order without a fill (most often the price bound); not chased", { reconciled: true }, deps);
    } else {
      await rejectInFlight(setup.active, [state], "OANDA has no record of the order and never confirmed it; nothing opened and it was not resent", { reconciled: true }, deps);
    }
  }

  // Open trades: book stop/target/manual closes, and run time exits.
  for (const setup of await setupsIn(deps.db, ["FILLED", "CLOSING"])) {
    const row = setup.active;
    const meta = metaOf(row);
    const trade = row.paper_trade_id ? (await deps.db.query<{ status: string; entry: string; stop: string; exit: string | null; paper_pl: string | null; result_r: string | null }>(
      "SELECT status, entry::text AS entry, stop::text AS stop, exit::text AS exit, paper_pl::text AS paper_pl, result_r::text AS result_r FROM paper_trades WHERE id=$1",
      [row.paper_trade_id],
    )).rows[0] : null;
    if (trade?.status === "closed" && meta.newsState === "FILLED") {
      // Closed by OANDA's stop or target (mirrored by the order reconciler) or by hand.
      const exit = trade.exit === null ? null : Number(trade.exit);
      const reason = exit === null ? "manual" : exitReasonOf(row.direction, exit, numberOrNull(row.stop_price), numberOrNull(row.target_price), meta.pipSize);
      if (await closeSetup(row, reason, exit, trade.paper_pl === null ? null : Number(trade.paper_pl), trade.result_r === null ? null : Number(trade.result_r), ["FILLED"], deps)) counts.closed += 1;
      continue;
    }
    const due = meta.timeExitAt && now >= Date.parse(meta.timeExitAt);
    const staleClaim = meta.newsState === "CLOSING" && now - Date.parse(meta.closingClaimedAt ?? row.updated_at) >= CLOSING_RETRY_MS;
    if (!(meta.newsState === "FILLED" && due) && !staleClaim) continue;
    if (meta.newsState === "FILLED") {
      const claimed = await deps.db.tx((client) => transition(client, setup.straddleId, ["FILLED"], "CLOSING", now, { reason: "time exit due" }, { closingClaimedAt: new Date(now).toISOString() }));
      if (!claimed) continue;
    } else {
      await deps.db.tx((client) => note(client, setup.straddleId, now, { note: "time exit retry" }, { closingClaimedAt: new Date(now).toISOString() }));
    }
    const tradeId = meta.brokerTradeId!;
    const before = await deps.broker.tradeState(tradeId).catch(() => null);
    let timeClosed = false;
    if (!before?.closed) {
      try {
        await deps.broker.closeTrade(tradeId);
        timeClosed = true;
      } catch (error) {
        deps.log({ event: "news_execution_error", setupId: setup.straddleId, step: "time exit close", error: String(error) });
      }
    }
    const after = await deps.broker.tradeState(tradeId).catch(() => null);
    if (!after?.closed) continue; // the claim goes stale and is retried
    const exit = after.averageClosePrice;
    const reason = timeClosed ? "time" : exit === null ? "manual" : exitReasonOf(row.direction, exit, numberOrNull(row.stop_price), numberOrNull(row.target_price), meta.pipSize);
    const resultR = exit === null || !trade ? null : manualBrokerCloseResultR({ direction: row.direction, entry: Number(trade.entry), stop: Number(trade.stop), exit });
    const pl = after.realizedPL;
    const result = pl === null ? (resultR === null ? "breakeven" : resultR > 0 ? "win" : resultR < 0 ? "loss" : "breakeven") : pl > 0 ? "win" : pl < 0 ? "loss" : "breakeven";
    await deps.db.query(
      `UPDATE paper_trades SET status='closed',result=$2,exit=$3,result_r=$4,paper_pl=$5,closed_at=$6,updated_at=now() WHERE id=$1 AND status='open'`,
      [row.paper_trade_id, result, exit ?? Number(trade?.entry ?? 0), resultR, pl, after.closeTime ?? new Date(now).toISOString()],
    );
    if (await closeSetup(row, reason, exit, pl, resultR, ["CLOSING"], deps)) counts.closed += 1;
  }

  await refreshArmedNewsStraddles(deps);
  return counts;
}

function numberOrNull(value: string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function closeSetup(row: PendingEntryRow, reason: "stop" | "target" | "manual" | "time", exit: number | null, pl: number | null, resultR: number | null, from: NewsState[], deps: NewsDeps) {
  const meta = metaOf(row);
  const now = deps.now();
  const detail = { exitReason: reason, exitPrice: exit, realizedPL: pl, resultR, closedAt: new Date(now).toISOString() };
  const moved = await deps.db.tx((client) => transition(client, meta.straddleId, from, "CLOSED", now, detail, detail));
  if (!moved) return false;
  const instrument = row.instrument;
  const words = { stop: "Stop-loss hit", target: "Take-profit hit", manual: "Closed by hand", time: `${meta.closeAfterMinutes} minutes passed without stop or target, so GX closed it at market` } as const;
  await publish({
    row, event: "news_trade_closed", title: `${displayPair(instrument)} news trade closed`,
    message: `${words[reason]}${exit === null ? "" : ` at ${fmt(instrument, exit)}`}${resultR === null ? "" : ` (${resultR >= 0 ? "+" : ""}${resultR.toFixed(2)}R)`}${pl === null ? "" : `, P/L ${pl >= 0 ? "+" : ""}${pl.toFixed(2)}`}.`,
    detail,
  }, deps);
  return true;
}

// ── Cancel ─────────────────────────────────────────────────────────────

/**
 * Cancel a setup that has not reserved an order. Once a side is reserved or
 * sent, cancelling is refused honestly: the order is being confirmed with
 * OANDA, and an open trade is closed only by the separate Close action.
 */
export async function cancelNewsStraddle(userId: string, straddleId: string, deps: NewsDeps = liveNewsDeps) {
  const now = deps.now();
  const out = await deps.db.tx(async (client) => {
    const setup = await lockRows(client, straddleId);
    if (!setup || setup.upper.user_id !== userId) throw new Error("News setup not found.");
    if (!CANCELLABLE.includes(setup.state)) {
      if (["TRIGGER_RESERVED", "ORDER_SUBMITTING", "ORDER_UNKNOWN"].includes(setup.state)) {
        throw new Error("An order for this setup is already being sent to OANDA, so it can't be cancelled. GX is confirming it; if it fills you can close the trade.");
      }
      if (setup.state === "FILLED" || setup.state === "CLOSING") throw new Error("This setup's trade is open. Use Close trade to close it.");
      throw new Error("This news setup has already ended.");
    }
    await transition(client, straddleId, [setup.state], "CANCELLED", now, { by: "user" });
    for (const row of [setup.upper, setup.lower]) await setRowStatus(client, row.id, "CANCELLED", { cancelled: true });
    return setup.upper;
  });
  forgetSetup(out.instrument, straddleId);
  await publish({ row: out, event: "news_setup_cancelled", title: `${displayPair(out.instrument)} news setup cancelled`, message: "You cancelled it. Both zones are off; no order was sent." }, deps);
  return (await readSetupRows(deps.db, straddleId)).map(serializePendingManualEntry);
}
