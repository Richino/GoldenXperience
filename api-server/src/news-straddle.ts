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
 * News mode: a two-line breakout armed around a release.
 *
 * A straddle is two linked rows in pending_manual_entries — a buy line above
 * the anchor and a sell line below it — sharing metadata.straddleId. Neither
 * rests at OANDA (the account cannot hold both sides). The server price
 * monitor watches live OANDA quotes; the first line crossed is claimed and
 * the other cancelled in ONE transaction, under an advisory lock and a
 * both-still-PENDING check, and only then is a single market order sent:
 *
 *   PENDING ×2 ─cross─▶ winner TRIGGERING + loser CANCELLED (committed first)
 *        │                 │ FOK market, priceBound = line ± slippage, stop by distance from the fill
 *        │                 ├─ filled ──────────▶ TRIGGERED (target moved to fill ± target pips; time exit armed)
 *        │                 ├─ BOUNDS_VIOLATION ▶ FAILED "missed bound" (never chased)
 *        │                 ├─ rejected ────────▶ FAILED
 *        │                 └─ no answer ───────▶ looked up by client id; NEVER resent
 *        └─ window ends ─▶ EXPIRED ×2 (disarmed)
 */

const RECONCILE_AFTER_MS = 15_000;
const GIVE_UP_AFTER_MS = 3 * 60_000;
const TIME_EXIT_RETRY_MS = 30_000;

export type NewsStraddleSide = "long" | "short";

export type NewsStraddleSettings = {
  distancePips: number;
  stopPips: number;
  targetPips: number;
  slippagePips: number;
  spreadCapPips: number;
  /** How long it watches after the release (or after arming, when the release is under a minute away). */
  armedMinutes: number;
  /** 0 = no time exit. */
  closeAfterMinutes: number;
  release: { id: string | null; title: string; currency: string | null; time: string | null } | null;
};

type NewsMeta = {
  mode: "news";
  straddleId: string;
  line: "upper" | "lower";
  execution: string;
  anchor: number;
  upperLine: number;
  lowerLine: number;
  distancePips: number;
  stopPips: number;
  targetPips: number;
  slippagePips: number;
  spreadCapPips: number;
  closeAfterMinutes: number;
  units: number;
  riskPercent: number;
  release: NewsStraddleSettings["release"];
  clientRequestId?: string;
  brokerTradeId?: string;
  timeExitAt?: string | null;
  timeExitState?: string;
  spreadBlockedAt?: string;
};

type Queryable = { query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }> };

export type NewsNotice =
  | "armed" | "live" | "triggered" | "missed_bound" | "rejected" | "time_exit" | "disarmed" | "spread_blocked" | "blocked" | "unprotected";

/** Everything with a side effect, so tests can run on one rolled-back connection with a fake broker. */
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
  notify: (input: { userId: string; instrument: string; key: string; event: NewsNotice; title: string; message: string }) => Promise<void>;
  /** Calendar releases (null when the calendar can't be read). */
  releases: () => Promise<Array<{ currency: string; title: string; timestamp: string }> | null>;
  /** A live quote, for activating a setup when no stream tick arrives. */
  quote: (instrument: MajorInstrument) => Promise<MarketPriceTick | null>;
  now: () => number;
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
      kind: input.event === "unprotected" ? "system_issue" : "trade_update",
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
};

// ── Pure decisions ────────────────────────────────────────────────────

export type NewsTickDecision =
  | { kind: "hold" }
  | { kind: "expired" }
  /** Both sides' executable prices are past their lines but the mid is between them: a spread artefact. No order. */
  | { kind: "ambiguous"; spreadPips: number }
  | { kind: "spread_blocked"; side: NewsStraddleSide; spreadPips: number }
  | { kind: "missed_bound"; side: NewsStraddleSide; price: number; bound: number; spreadPips: number }
  | { kind: "fire"; side: NewsStraddleSide; price: number; bound: number; spreadPips: number };

/**
 * What one live quote means for an armed straddle. A long fills at the ask,
 * so the buy line is crossed when the ask reaches it; a short at the bid. A
 * single quote can only put its mid past one line, so when a huge spread puts
 * both executable prices past their lines, the side is the one the mid moved
 * through; with the mid still between the lines nothing is sent.
 */
export function decideNewsStraddleTick(input: {
  upper: number;
  lower: number;
  bid: number;
  ask: number;
  expiresAt: string | null;
  now: number;
  pip: number;
  slippagePips: number;
  spreadCapPips: number;
}): NewsTickDecision {
  if (input.expiresAt && Date.parse(input.expiresAt) <= input.now) return { kind: "expired" };
  const longHit = input.ask >= input.upper;
  const shortHit = input.bid <= input.lower;
  if (!longHit && !shortHit) return { kind: "hold" };
  const spreadPips = (input.ask - input.bid) / input.pip;
  let side: NewsStraddleSide;
  if (longHit && shortHit) {
    const mid = (input.bid + input.ask) / 2;
    if (mid >= input.upper) side = "long";
    else if (mid <= input.lower) side = "short";
    else return { kind: "ambiguous", spreadPips };
  } else {
    side = longHit ? "long" : "short";
  }
  if (spreadPips > input.spreadCapPips + 1e-9) return { kind: "spread_blocked", side, spreadPips };
  const slip = input.slippagePips * input.pip;
  const price = side === "long" ? input.ask : input.bid;
  const bound = side === "long" ? input.upper + slip : input.lower - slip;
  const beyond = side === "long" ? price > bound + 1e-12 : price < bound - 1e-12;
  return beyond ? { kind: "missed_bound", side, price, bound, spreadPips } : { kind: "fire", side, price, bound, spreadPips };
}

/** Pips the fill landed past the line: positive is worse for the trade. */
export function newsSlippagePips(side: NewsStraddleSide, line: number, fill: number, pip: number) {
  return Number((((side === "long" ? fill - line : line - fill) / pip)).toFixed(1));
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

/** Releases count as "news ahead" this far out; News mode arms only for one. */
export const NEWS_LOOKAHEAD_MS = 5 * 60 * 60_000;
/** The anchor is the live price this long before the release. */
export const NEWS_ANCHOR_LEAD_MS = 60_000;

/** Validate the ticket's News-mode fields. There is no anchor: it is always the live price. */
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

/** The two zones around an anchor: entry edge `distance` pips out, far edge `depth` pips further. */
export function newsZones(instrument: string, anchor: number, distancePips: number, depthPips: number) {
  const pip = pipSizeFor(instrument);
  const r = (value: number) => Number(value.toFixed(precisionFor(instrument)));
  const upper = r(anchor + distancePips * pip);
  const lower = r(anchor - distancePips * pip);
  return { upper, upperFar: r(upper + depthPips * pip), lower, lowerFar: r(lower - depthPips * pip) };
}

// ── Arming ────────────────────────────────────────────────────────────

const metaOf = (row: PendingEntryRow) => (row.metadata ?? {}) as unknown as NewsMeta;
const fmt = (instrument: string, value: number) => value.toFixed(precisionFor(instrument));
const round = (instrument: string, value: number) => Number(value.toFixed(precisionFor(instrument)));
const releaseLabel = (release: NonNullable<NewsStraddleSettings["release"]>) => `${release.currency ? `${release.currency} ` : ""}${release.title}`;
const clockText = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

async function riskSettings(db: Queryable, userId: string) {
  const row = (await db.query<{ kill_switch: boolean; max_risk_percent: string }>(
    "SELECT kill_switch, max_risk_percent::text FROM trade_plan_risk_settings WHERE user_id=$1",
    [userId],
  )).rows[0];
  return { killSwitch: row?.kill_switch === true, maxRiskPercent: row ? Number(row.max_risk_percent) : null };
}

const PAIR_BUSY_SQL = `CASE
       WHEN EXISTS (SELECT 1 FROM paper_strategy_trades WHERE user_id=$1 AND instrument=$2 AND status='open')
         OR EXISTS (SELECT 1 FROM paper_trades WHERE user_id=$1 AND pair=$3 AND status='open') THEN 'open'
       WHEN EXISTS (SELECT 1 FROM pending_manual_entries WHERE user_id=$1 AND instrument=$2 AND status IN ('PENDING','TRIGGERING')
                      AND COALESCE(metadata->>'straddleId','') <> COALESCE($4::text,'')) THEN 'pending'
       ELSE NULL END`;

/** Any open trade on the pair, or any waiting/in-flight entry: News mode keeps one trade per pair. */
async function pairBusy(db: Queryable, userId: string, instrument: string, exceptStraddle: string | null) {
  const result = await db.query<{ busy: string | null }>(`SELECT ${PAIR_BUSY_SQL} AS busy`, [userId, instrument, instrument.replace("_", "/"), exceptStraddle]);
  return result.rows[0]?.busy ?? null;
}

/** Kill switch and one-trade-per-pair in a single round trip, for the moment of firing. */
async function fireChecks(db: Queryable, userId: string, instrument: string, straddleId: string) {
  const row = (await db.query<{ kill_switch: boolean | null; busy: string | null }>(
    `SELECT (SELECT kill_switch FROM trade_plan_risk_settings WHERE user_id=$1) AS kill_switch, ${PAIR_BUSY_SQL} AS busy`,
    [userId, instrument, instrument.replace("_", "/"), straddleId],
  )).rows[0];
  return { killSwitch: row?.kill_switch === true, busy: row?.busy ?? null };
}

export async function armNewsStraddle(userId: string, payload: Record<string, unknown>, tick: MarketPriceTick, deps: NewsDeps = liveNewsDeps) {
  if (tick.source !== "oanda" || !(tick.bid > 0) || !(tick.ask >= tick.bid)) throw new Error("A live OANDA quote is required to arm a news setup.");
  const now = deps.now();
  if (now - Date.parse(tick.time) > 30_000) throw new Error("The market price is stale. Wait for a fresh OANDA quote.");
  if (payload.instrument !== tick.instrument) throw new Error("The selected instrument does not match the live quote.");
  if (deps.broker.environment() !== "practice") throw new Error("News mode only trades the OANDA practice account.");
  const instrument = tick.instrument;
  const pip = pipSizeFor(instrument);
  const settings = parseNewsStraddleSettings(payload);
  const release = settings.release!;
  // Phase 1: a release for this pair in the next 5 hours, confirmed by the server's own calendar.
  const releaseAt = Date.parse(release.time!);
  const events = await deps.releases();
  if (!events) throw new Error("The economic calendar can't be read right now, so the release can't be confirmed. Try again shortly.");
  const ahead = upcomingPairReleases(instrument, events, now);
  const { base: baseCurrency, quote: quoteCurrency } = currenciesOf(instrument);
  if (!ahead.length) throw new Error(`No ${baseCurrency} or ${quoteCurrency} news in the next 5 hours. News mode only arms ahead of a release.`);
  if (!ahead.some((event) => Math.abs(Date.parse(event.timestamp) - releaseAt) < 60_000 && (!release.currency || event.currency === release.currency))) {
    throw new Error("That release is not in the calendar for the next 5 hours. Pick it again from the list.");
  }
  const risk = await riskSettings(deps.db, userId);
  if (risk.killSwitch) throw new Error("The execution kill switch is on (Settings). Turn it off to arm a news setup.");
  const busy = await pairBusy(deps.db, userId, instrument, null);
  if (busy) throw new Error(busy === "open"
    ? "This pair already has an open trade. News mode opens one trade per pair, so close it first."
    : "This pair already has a waiting entry. Cancel it first; News mode holds one trade per pair.");
  // Phase 2: the anchor is the live price. With the release more than a minute
  // away the setup waits and takes the price one minute before it; otherwise now.
  const activateAt = releaseAt - NEWS_ANCHOR_LEAD_MS > now ? new Date(releaseAt - NEWS_ANCHOR_LEAD_MS).toISOString() : null;
  const anchor = round(instrument, (tick.bid + tick.ask) / 2);
  const zones = newsZones(instrument, anchor, settings.distancePips, settings.slippagePips);
  if (!activateAt && (tick.ask >= zones.upper || tick.bid <= zones.lower)) {
    throw new Error(`The spread (${((tick.ask - tick.bid) / pip).toFixed(1)} pips) already reaches a zone ${settings.distancePips} pips out. Widen the distance.`);
  }
  // Both sides carry the same stop distance, so one size fits either side.
  const sized = await deps.size(userId, instrument, zones.upper, zones.upper - settings.stopPips * pip);
  if (risk.maxRiskPercent !== null && sized.riskPercent > risk.maxRiskPercent + 1e-9) {
    throw new Error(`Your risk per trade (${sized.riskPercent}%) is above the max risk limit (${risk.maxRiskPercent}%) in Settings.`);
  }
  const straddleId = randomUUID();
  const expiresAt = new Date(Math.max(releaseAt, now) + settings.armedMinutes * 60_000).toISOString();
  const base = {
    mode: "news", straddleId, execution: activateAt ? "news_waiting" : "news_armed", createdFrom: "chart", priceSource: tick.source,
    anchor, upperLine: zones.upper, lowerLine: zones.lower, upperFar: zones.upperFar, lowerFar: zones.lowerFar,
    distancePips: settings.distancePips, stopPips: settings.stopPips, targetPips: settings.targetPips,
    slippagePips: settings.slippagePips, spreadCapPips: settings.spreadCapPips, closeAfterMinutes: settings.closeAfterMinutes,
    units: sized.units, riskPercent: sized.riskPercent, release, tradeStyle: "day",
    spreadAtArmPips: Number(((tick.ask - tick.bid) / pip).toFixed(1)),
    activatedAt: activateAt ? null : new Date(now).toISOString(),
  };
  const rows = await deps.db.tx(async (client) => {
    await client.query(
      "INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING",
      [instrument, displayPair(instrument), precisionFor(instrument)],
    );
    const inserted: PendingEntryRow[] = [];
    for (const [direction, line, price, orderType] of [["long", "upper", zones.upper, "buy_stop"], ["short", "lower", zones.lower, "sell_stop"]] as const) {
      const result = await client.query<PendingEntryRow>(
        `INSERT INTO pending_manual_entries(user_id,instrument,direction,entry_price,entry_order_type,current_price_at_creation,
           expiration_type,expires_at,activate_at,last_observed_price,last_observed_at,metadata)
         VALUES($1,$2,$3,$4,$5,$6,'time',$7,$8,$6,$9,$10::jsonb) RETURNING ${PENDING_ENTRY_FIELDS}`,
        [userId, instrument, direction, price, orderType, anchor, expiresAt, activateAt, tick.time, JSON.stringify({ ...base, line })],
      );
      inserted.push(result.rows[0]!);
    }
    return inserted;
  });
  rememberStraddle(rows[0]!, rows[1]!);
  await deps.notify({
    userId, instrument, key: straddleId, event: "armed",
    title: `${displayPair(instrument)} news setup armed for ${releaseLabel(release)}`,
    message: (activateAt
      ? `Release at ${clockText(release.time!)}. One minute before it, GX takes the live price as the anchor and sets the zones ${settings.distancePips}–${settings.distancePips + settings.slippagePips} pips either side. `
      : `Buy zone ${fmt(instrument, zones.upper)}–${fmt(instrument, zones.upperFar)}, sell zone ${fmt(instrument, zones.lower)}–${fmt(instrument, zones.lowerFar)} around ${fmt(instrument, anchor)}. `)
      + `Price entering a zone sends the order; it fills only inside the zone. Stop ${settings.stopPips}p, target ${settings.targetPips}p from the fill, spread cap ${settings.spreadCapPips}p. `
      + `Spread now ${base.spreadAtArmPips} pips. Watches until ${clockText(expiresAt)}, then disarms.`,
  });
  return rows.map(serializePendingManualEntry);
}

// ── The tick monitor ──────────────────────────────────────────────────

/**
 * Armed setups held in memory so an ordinary tick costs no database work:
 * only a tick that enters a zone (or ends the window, or is due to set the
 * anchor) goes to the database, where the locked transaction decides. The
 * sweep reloads this every 5 seconds; the database stays the authority.
 */
type CachedStraddle = {
  straddleId: string;
  instrument: string;
  upper: number;
  lower: number;
  expiresAt: number;
  activateAt: number | null;
  waiting: boolean;
  slippagePips: number;
  spreadCapPips: number;
};
const armed = new Map<string, Map<string, CachedStraddle>>();

function rememberStraddle(first: PendingEntryRow, second: PendingEntryRow) {
  const upper = metaOf(first).line === "upper" ? first : second;
  const lower = upper === first ? second : first;
  const meta = metaOf(upper);
  const byInstrument = armed.get(upper.instrument) ?? new Map<string, CachedStraddle>();
  byInstrument.set(meta.straddleId, {
    straddleId: meta.straddleId,
    instrument: upper.instrument,
    upper: Number(upper.entry_price),
    lower: Number(lower.entry_price),
    expiresAt: upper.expires_at ? Date.parse(upper.expires_at) : Number.POSITIVE_INFINITY,
    activateAt: upper.activate_at ? Date.parse(upper.activate_at) : null,
    waiting: meta.execution === "news_waiting",
    slippagePips: meta.slippagePips,
    spreadCapPips: meta.spreadCapPips,
  });
  armed.set(upper.instrument, byInstrument);
}

function forgetStraddle(instrument: string, straddleId: string) {
  armed.get(instrument)?.delete(straddleId);
}

/** Reload the in-memory set from the database. */
export async function refreshArmedNewsStraddles(deps: NewsDeps = liveNewsDeps) {
  const rows = (await deps.db.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE status='PENDING' AND metadata->>'mode'='news'`,
  )).rows;
  armed.clear();
  const groups = new Map<string, PendingEntryRow[]>();
  for (const row of rows) groups.set(metaOf(row).straddleId, [...(groups.get(metaOf(row).straddleId) ?? []), row]);
  for (const group of groups.values()) {
    if (group.length === 2) rememberStraddle(group[0]!, group[1]!);
  }
  return groups.size;
}

/** Cheap gate for the per-tick hook: true when this instrument has an armed or waiting setup. */
export function newsStraddleMayBeArmed(instrument: string) {
  return (armed.get(instrument)?.size ?? 0) > 0;
}

/**
 * Set a waiting setup's anchor to the live mid and its zones around it, one
 * minute before the release. Runs once per setup (only while still waiting).
 */
async function activateStraddle(straddleId: string, tick: MarketPriceTick, deps: NewsDeps) {
  const now = deps.now();
  const result = await deps.db.tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`news-straddle:${straddleId}`]);
    const locked = (await client.query<PendingEntryRow>(
      `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 FOR UPDATE`,
      [straddleId],
    )).rows;
    if (locked.length !== 2 || locked.some((row) => row.status !== "PENDING" || metaOf(row).execution !== "news_waiting")) return null;
    const meta = metaOf(locked[0]!);
    const instrument = locked[0]!.instrument;
    const anchor = round(instrument, (tick.bid + tick.ask) / 2);
    const zones = newsZones(instrument, anchor, meta.distancePips, meta.slippagePips);
    const updated: PendingEntryRow[] = [];
    for (const row of locked) {
      const isUpper = metaOf(row).line === "upper";
      updated.push((await client.query<PendingEntryRow>(
        `UPDATE pending_manual_entries SET entry_price=$2,current_price_at_creation=$3,last_observed_price=$3,last_observed_at=$4,
           metadata=metadata||$5::jsonb,updated_at=now()
         WHERE id=$1 AND status='PENDING' RETURNING ${PENDING_ENTRY_FIELDS}`,
        [row.id, isUpper ? zones.upper : zones.lower, anchor, new Date(now), JSON.stringify({
          execution: "news_armed", anchor, upperLine: zones.upper, lowerLine: zones.lower, upperFar: zones.upperFar, lowerFar: zones.lowerFar,
          activatedAt: new Date(now).toISOString(), spreadAtActivationPips: Number(((tick.ask - tick.bid) / pipSizeFor(instrument)).toFixed(1)),
        })],
      )).rows[0]!);
    }
    return { updated, zones, anchor };
  });
  if (!result) {
    await refreshOne(straddleId, deps);
    return;
  }
  rememberStraddle(result.updated[0]!, result.updated[1]!);
  const row = result.updated[0]!;
  const instrument = row.instrument;
  const meta = metaOf(row);
  await emit(row, "live", `${displayPair(instrument)} news zones set`,
    `Anchor ${fmt(instrument, result.anchor)} (live price). Buy zone ${fmt(instrument, result.zones.upper)}–${fmt(instrument, result.zones.upperFar)}, `
    + `sell zone ${fmt(instrument, result.zones.lower)}–${fmt(instrument, result.zones.lowerFar)}. `
    + `Spread ${((tick.ask - tick.bid) / pipSizeFor(instrument)).toFixed(1)} pips.${meta.release ? ` ${releaseLabel(meta.release)} at ${clockText(meta.release.time!)}.` : ""}`, deps);
}

/** Re-read one setup into the cache (or drop it when it is no longer armed). */
async function refreshOne(straddleId: string, deps: NewsDeps) {
  const rows = (await deps.db.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE metadata->>'straddleId'=$1`,
    [straddleId],
  )).rows;
  if (rows.length === 2 && rows.every((row) => row.status === "PENDING")) rememberStraddle(rows[0]!, rows[1]!);
  else if (rows[0]) forgetStraddle(rows[0].instrument, straddleId);
}

type Claim =
  | { kind: "none" }
  | { kind: "notify"; row: PendingEntryRow; event: NewsNotice; title: string; message: string }
  | { kind: "fire"; row: PendingEntryRow; bound: number; spreadPips: number; price: number };

/**
 * Settle one straddle against one quote inside a single transaction. The
 * advisory lock serialises any two workers on the same straddle; the
 * both-rows-PENDING check and conditional updates make a second tick a no-op
 * once a side has been claimed.
 */
async function settleStraddle(straddleId: string, tick: MarketPriceTick, deps: NewsDeps): Promise<Claim> {
  return deps.db.tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`news-straddle:${straddleId}`]);
    const locked = await client.query<PendingEntryRow>(
      `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 FOR UPDATE`,
      [straddleId],
    );
    const upper = locked.rows.find((row) => metaOf(row).line === "upper");
    const lower = locked.rows.find((row) => metaOf(row).line === "lower");
    if (!upper || !lower || upper.status !== "PENDING" || lower.status !== "PENDING") return { kind: "none" };
    const meta = metaOf(upper);
    const instrument = upper.instrument;
    const pip = pipSizeFor(instrument);
    const now = deps.now();
    const tickTime = Number.isFinite(Date.parse(tick.time)) ? new Date(tick.time) : new Date(now);
    const mid = (tick.bid + tick.ask) / 2;
    const decision = decideNewsStraddleTick({
      upper: Number(upper.entry_price), lower: Number(lower.entry_price), bid: tick.bid, ask: tick.ask,
      expiresAt: upper.expires_at, now, pip, slippagePips: meta.slippagePips, spreadCapPips: meta.spreadCapPips,
    });
    const observe = () => client.query(
      "UPDATE pending_manual_entries SET last_observed_price=$2,last_observed_at=$3,updated_at=now() WHERE metadata->>'straddleId'=$1 AND status='PENDING'",
      [straddleId, mid, tickTime],
    );
    const pair = displayPair(instrument);
    // A setup still waiting for its anchor can only end; it never fires.
    if (meta.execution === "news_waiting" && decision.kind !== "expired") return { kind: "none" };
    if (decision.kind === "hold" || decision.kind === "ambiguous") {
      await observe();
      if (decision.kind === "ambiguous") console.warn(`[news-straddle] ${straddleId} both lines crossed by a ${decision.spreadPips.toFixed(1)}-pip spread with the mid between them; no order`);
      return { kind: "none" };
    }
    if (decision.kind === "expired") {
      await client.query(
        "UPDATE pending_manual_entries SET status='EXPIRED',updated_at=now(),metadata=metadata||'{\"execution\":\"news_disarmed\"}'::jsonb WHERE metadata->>'straddleId'=$1 AND status='PENDING'",
        [straddleId],
      );
      return { kind: "notify", row: upper, event: "disarmed", title: `${pair} news setup disarmed`, message: "Price did not enter either zone before the window ended. No order was sent." };
    }
    if (decision.kind === "spread_blocked") {
      await observe();
      const first = !meta.spreadBlockedAt;
      if (first) {
        await client.query(
          "UPDATE pending_manual_entries SET metadata=metadata||jsonb_build_object('spreadBlockedAt',$2::text) WHERE metadata->>'straddleId'=$1 AND status='PENDING'",
          [straddleId, new Date(now).toISOString()],
        );
      }
      return first
        ? { kind: "notify", row: upper, event: "spread_blocked", title: `${pair} news line crossed — spread too wide`, message: `The ${decision.side === "long" ? "buy" : "sell"} line was crossed with a ${decision.spreadPips.toFixed(1)}-pip spread, above your ${meta.spreadCapPips}-pip cap. No order yet; still armed, and it fires if price is still within the slippage bound once the spread is back under the cap.` }
        : { kind: "none" };
    }
    const winner = decision.side === "long" ? upper : lower;
    const loser = decision.side === "long" ? lower : upper;
    const line = Number(winner.entry_price);
    // Safety checks at the moment of firing: kill switch, account, one trade per pair.
    const { killSwitch, busy } = await fireChecks(client, winner.user_id, instrument, straddleId);
    const blocked = killSwitch ? "the execution kill switch is on"
      : deps.broker.environment() !== "practice" ? "the broker account is not the OANDA practice account"
        : busy ? `this pair already has ${busy === "open" ? "an open trade" : "another waiting entry"}`
          : null;
    if (blocked || decision.kind === "missed_bound") {
      const reason = blocked
        ? `Not sent: ${blocked}.`
        : `Missed the price bound: ${decision.side === "long" ? "ask" : "bid"} ${fmt(instrument, decision.price)} was already past ${fmt(instrument, decision.bound)} (line ${fmt(instrument, line)} ± ${meta.slippagePips} pips). Not chased.`;
      await client.query(
        `UPDATE pending_manual_entries SET status='FAILED',failure_reason=$2,trigger_price=$3,triggered_at=$4,last_observed_price=$5,last_observed_at=$4,
           metadata=metadata||jsonb_build_object('execution',$6::text,'spreadAtTriggerPips',$7::numeric),updated_at=now()
         WHERE id=$1 AND status='PENDING'`,
        [winner.id, reason, decision.price, tickTime, mid, blocked ? "news_blocked" : "news_missed_bound", Number(decision.spreadPips.toFixed(1))],
      );
      await client.query(
        `UPDATE pending_manual_entries SET status='CANCELLED',cancelled_at=now(),metadata=metadata||'{"execution":"news_sibling_closed"}'::jsonb,updated_at=now()
         WHERE id=$1 AND status='PENDING'`,
        [loser.id],
      );
      return blocked
        ? { kind: "notify", row: winner, event: "blocked", title: `${pair} news line crossed — no order`, message: `${reason} Both lines are now off.` }
        : { kind: "notify", row: winner, event: "missed_bound", title: `${pair} news move missed the bound`, message: `${reason} Spread was ${decision.spreadPips.toFixed(1)} pips. Both lines are now off.` };
    }
    // Claim: the winner goes in flight and the loser is cancelled in this same
    // commit, before anything is sent — two sides can never both reach OANDA.
    const clientRequestId = `news-${winner.id}`;
    const claimed = await client.query<PendingEntryRow>(
      `UPDATE pending_manual_entries SET status='TRIGGERING',trigger_price=$2,triggered_at=$3,last_observed_price=$4,last_observed_at=$3,
         metadata=metadata||jsonb_build_object('execution','news_submitting','clientRequestId',$5::text,'priceBound',$6::numeric,
           'triggerBid',$7::numeric,'triggerAsk',$8::numeric,'spreadAtTriggerPips',$9::numeric,'submittedAt',$10::text),updated_at=now()
       WHERE id=$1 AND status='PENDING' RETURNING ${PENDING_ENTRY_FIELDS}`,
      [winner.id, decision.price, tickTime, mid, clientRequestId, round(instrument, decision.bound), tick.bid, tick.ask, Number(decision.spreadPips.toFixed(1)), new Date(now).toISOString()],
    );
    const cancelled = await client.query(
      `UPDATE pending_manual_entries SET status='CANCELLED',cancelled_at=now(),metadata=metadata||'{"execution":"news_sibling_triggered"}'::jsonb,updated_at=now()
       WHERE id=$1 AND status='PENDING'`,
      [loser.id],
    );
    if (!claimed.rows[0] || cancelled.rowCount !== 1) throw new Error(`news straddle ${straddleId} changed state mid-claim`);
    return { kind: "fire", row: claimed.rows[0], bound: decision.bound, spreadPips: decision.spreadPips, price: decision.price };
  });
}

async function emit(row: PendingEntryRow, event: NewsNotice, title: string, message: string, deps: NewsDeps, key?: string) {
  await deps.notify({ userId: row.user_id, instrument: row.instrument, key: key ?? metaOf(row).straddleId, event, title, message });
}

/**
 * Run this instrument's setups against a live quote. Ordinary ticks are
 * decided from memory with no database work; a tick that enters a zone,
 * ends the window or is due to set the anchor goes to the locked
 * transaction, which decides again from the database rows.
 */
export async function evaluateNewsStraddles(tick: MarketPriceTick, deps: NewsDeps = liveNewsDeps) {
  if (!(tick.bid > 0) || !(tick.ask >= tick.bid)) return { fired: 0 };
  const setups = [...(armed.get(tick.instrument)?.values() ?? [])];
  if (!setups.length) return { fired: 0 };
  const now = deps.now();
  const pip = pipSizeFor(tick.instrument);
  let fired = 0;
  for (const setup of setups) {
    if (setup.waiting && now < setup.expiresAt) {
      if (setup.activateAt !== null && now >= setup.activateAt) await activateStraddle(setup.straddleId, tick, deps);
      continue;
    }
    const quick = decideNewsStraddleTick({
      upper: setup.upper, lower: setup.lower, bid: tick.bid, ask: tick.ask,
      expiresAt: Number.isFinite(setup.expiresAt) ? new Date(setup.expiresAt).toISOString() : null,
      now, pip, slippagePips: setup.slippagePips, spreadCapPips: setup.spreadCapPips,
    });
    if (quick.kind === "hold" || quick.kind === "ambiguous") continue;
    const claim = await settleStraddle(setup.straddleId, tick, deps);
    if (claim.kind === "fire") {
      // Off the watch list before the request, so no later tick even reaches the database.
      forgetStraddle(tick.instrument, setup.straddleId);
      fired += 1;
      await submitClaimed(claim.row, claim.bound, deps);
      continue;
    }
    if (claim.kind === "notify") await emit(claim.row, claim.event, claim.title, claim.message, deps);
    await refreshOne(setup.straddleId, deps);
  }
  return { fired };
}

/** Send the one market order for a claimed side. Never called twice for a row: the claim is the gate. */
async function submitClaimed(row: PendingEntryRow, bound: number, deps: NewsDeps) {
  const meta = metaOf(row);
  const instrument = row.instrument;
  const pip = pipSizeFor(instrument);
  const side = row.direction;
  const line = Number(row.entry_price);
  const clientRequestId = meta.clientRequestId ?? `news-${row.id}`;
  // Provisional target from the line; moved to fill ± target pips once filled.
  const provisionalTarget = round(instrument, side === "long" ? line + meta.targetPips * pip : line - meta.targetPips * pip);
  let result: Awaited<ReturnType<NewsDeps["broker"]["submit"]>>;
  try {
    result = await deps.broker.submit({
      instrument, direction: side, units: meta.units, stopDistance: meta.stopPips * pip, target: provisionalTarget,
      priceBound: bound, clientRequestId, tradeClientId: `gxt-${clientRequestId}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OANDA request failed.";
    if (submitFailureKind(error instanceof OandaRequestError ? error.status : undefined) === "rejected") {
      await failInFlight(row, `OANDA rejected the order: ${message}`, "news_rejected", deps);
      await emit(row, "rejected", `${displayPair(instrument)} news order rejected`, `OANDA refused the ${side} order (${message}). Nothing is open.`, deps);
    } else {
      // The order may or may not exist. Look it up by client id later; never resend.
      await deps.db.query(
        `UPDATE pending_manual_entries SET metadata=metadata||jsonb_build_object('execution','news_unknown','submitError',$2::text),updated_at=now()
          WHERE id=$1 AND status='TRIGGERING'`,
        [row.id, message.slice(0, 300)],
      );
    }
    return;
  }
  if (result.cancelReason === "BOUNDS_VIOLATION") {
    await failInFlight(row, `Missed the price bound ${fmt(instrument, bound)} (line ${fmt(instrument, line)} ± ${meta.slippagePips} pips): price moved past it before the fill. Not chased.`, "news_missed_bound", deps);
    await emit(row, "missed_bound", `${displayPair(instrument)} news move missed the bound`, `OANDA could not fill the ${side} within ${meta.slippagePips} pips of the line (bound ${fmt(instrument, bound)}), so nothing opened. Not chased; both lines are off.`, deps);
    return;
  }
  if (result.cancelReason || !result.tradeId || result.fillPrice === null) {
    const reason = result.cancelReason ?? "OANDA did not open a trade.";
    await failInFlight(row, `OANDA did not open the trade (${reason}).`, "news_rejected", deps);
    await emit(row, "rejected", `${displayPair(instrument)} news order not filled`, `OANDA did not open the ${side} (${reason}). Nothing is open.`, deps);
    return;
  }
  await recordNewsFill(row, result.tradeId, result.fillPrice, result.fillSpread, deps);
}

async function failInFlight(row: PendingEntryRow, reason: string, execution: string, deps: NewsDeps) {
  await deps.db.query(
    `UPDATE pending_manual_entries SET status='FAILED',failure_reason=$2,metadata=metadata||jsonb_build_object('execution',$3::text),updated_at=now()
      WHERE id=$1 AND status='TRIGGERING'`,
    [row.id, reason.slice(0, 500), execution],
  );
}

/** Book a confirmed fill: move the target to fill ± target pips, verify the stop, open the app trade, arm the time exit. */
async function recordNewsFill(row: PendingEntryRow, tradeId: string, fillPrice: number, fillSpread: number | null, deps: NewsDeps) {
  const meta = metaOf(row);
  const instrument = row.instrument;
  const pip = pipSizeFor(instrument);
  const side = row.direction;
  const line = Number(row.entry_price);
  const stop = round(instrument, side === "long" ? fillPrice - meta.stopPips * pip : fillPrice + meta.stopPips * pip);
  const target = round(instrument, side === "long" ? fillPrice + meta.targetPips * pip : fillPrice - meta.targetPips * pip);
  let targetMoved = true;
  try {
    await deps.broker.setLevels(tradeId, instrument, { target });
  } catch (error) {
    targetMoved = false;
    console.error(`[news-straddle] ${row.id} could not move the target to the fill`, error);
  }
  const protection = await deps.broker.protection(tradeId).catch(() => null);
  const brokerStop = protection?.stopLoss ?? null;
  const brokerTarget = protection?.takeProfit ?? (targetMoved ? target : null);
  const slippagePips = newsSlippagePips(side, line, fillPrice, pip);
  const spreadAtFillPips = fillSpread !== null ? Number((fillSpread / pip).toFixed(1)) : null;
  const filledAt = new Date(deps.now());
  const timeExitAt = meta.closeAfterMinutes > 0 ? new Date(filledAt.getTime() + meta.closeAfterMinutes * 60_000).toISOString() : null;
  const opened = await deps.db.tx(async (client) => {
    const locked = await client.query<PendingEntryRow>(`SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE id=$1 FOR UPDATE`, [row.id]);
    if (locked.rows[0]?.status !== "TRIGGERING") return null;
    const trade = await client.query<{ id: string }>(
      `INSERT INTO paper_trades(user_id,legacy_id,origin,pair,direction,status,result,opened_at,entry,stop,target,reason,notes)
       VALUES($1,$2,'manual',$3,$4,'open','open',$5,$6,$7,$8,'News breakout filled',$9)
       ON CONFLICT(user_id,legacy_id) DO UPDATE SET updated_at=paper_trades.updated_at RETURNING id`,
      [row.user_id, `pending-entry:${row.id}`, instrument.replace("_", "/"), side, filledAt, fillPrice, brokerStop ?? stop, brokerTarget ?? target,
        `News straddle ${meta.straddleId}; line ${line}, fill ${fillPrice}, slippage ${slippagePips} pips; broker trade ${tradeId}.`],
    );
    await client.query(
      `UPDATE pending_manual_entries SET status='TRIGGERED',trigger_price=$2,stop_price=$3,target_price=$4,paper_trade_id=$5,
         metadata=metadata||$6::jsonb,updated_at=now()
       WHERE id=$1 AND status='TRIGGERING'`,
      [row.id, fillPrice, brokerStop ?? stop, brokerTarget ?? target, trade.rows[0]!.id, JSON.stringify({
        execution: "news_filled", brokerTradeId: tradeId, fillPrice, slippagePips, spreadAtFillPips, filledAt: filledAt.toISOString(), timeExitAt,
        targetMovedToFill: targetMoved,
      })],
    );
    return trade.rows[0]!.id;
  });
  if (!opened) return;
  const pair = displayPair(instrument);
  if (brokerStop === null) {
    // The stop rides on the order itself, so this should not happen; if OANDA
    // does not confirm one, close rather than hold an unprotected news trade.
    let closed = false;
    try { await deps.broker.closeTrade(tradeId); closed = true; } catch (error) { console.error(`[news-straddle] could not close unprotected trade ${tradeId}`, error); }
    await emit(row, "unprotected", `URGENT: ${pair} news trade had no stop`, closed
      ? `OANDA did not confirm a stop on trade ${tradeId}, so GX closed it straight away.`
      : `OANDA did not confirm a stop on trade ${tradeId} and GX could not close it. Close it in OANDA now.`, deps);
    return;
  }
  const triggerSpread = (row.metadata as { spreadAtTriggerPips?: number } | null)?.spreadAtTriggerPips;
  const spreadText = spreadAtFillPips !== null ? `${spreadAtFillPips} pips at fill`
    : triggerSpread !== undefined ? `${triggerSpread} pips at trigger` : "not reported";
  await emit(row, "triggered", `${pair} news ${side === "long" ? "LONG" : "SHORT"} filled`,
    `${side === "long" ? "Bought" : "Sold"} at ${fmt(instrument, fillPrice)} (line ${fmt(instrument, line)}, slippage ${slippagePips >= 0 ? "+" : ""}${slippagePips} pips). Spread ${spreadText}. `
    + `Stop ${fmt(instrument, brokerStop)}, target ${brokerTarget === null ? "not set" : fmt(instrument, brokerTarget)}${targetMoved ? "" : " (still at the line-based level; OANDA did not accept the move)"}. `
    + (timeExitAt ? `Closes at market at ${new Date(timeExitAt).toISOString().slice(11, 16)} UTC if neither hits.` : "No time exit."), deps);
}

// ── Sweep: expiry without ticks, lost responses, restart recovery, time exits ──

/**
 * Runs on a timer and once at startup. Disarms straddles whose window ended
 * while no quote arrived, reconciles in-flight orders by client id (after a
 * timeout or a restart — never resending), and closes filled news trades at
 * market when their time exit is due.
 */
export async function sweepNewsStraddles(deps: NewsDeps = liveNewsDeps) {
  let disarmed = 0, reconciled = 0, timeExits = 0;
  const now = deps.now();

  const due = await deps.db.query<{ straddle_id: string; instrument: string }>(
    `SELECT DISTINCT metadata->>'straddleId' AS straddle_id, instrument FROM pending_manual_entries
      WHERE status='PENDING' AND metadata->>'mode'='news'`,
  );
  for (const item of due.rows) {
    const disarm = await deps.db.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`news-straddle:${item.straddle_id}`]);
      const result = await client.query<PendingEntryRow>(
        `UPDATE pending_manual_entries SET status='EXPIRED',updated_at=now(),metadata=metadata||'{"execution":"news_disarmed"}'::jsonb
          WHERE metadata->>'straddleId'=$1 AND status='PENDING' AND expires_at<=$2 RETURNING ${PENDING_ENTRY_FIELDS}`,
        [item.straddle_id, new Date(now)],
      );
      return result.rows[0] ?? null;
    });
    if (disarm) {
      disarmed += 1;
      await emit(disarm, "disarmed", `${displayPair(disarm.instrument)} news setup disarmed`, "Price did not enter either zone before the window ended. No order was sent.", deps);
    }
  }

  // Set the anchor of setups whose time came with no stream tick (a quiet market).
  const waiting = await deps.db.query<{ straddle_id: string; instrument: MajorInstrument }>(
    `SELECT DISTINCT metadata->>'straddleId' AS straddle_id, instrument FROM pending_manual_entries
      WHERE status='PENDING' AND metadata->>'mode'='news' AND metadata->>'execution'='news_waiting'
        AND activate_at <= $1 AND expires_at > $1`,
    [new Date(now)],
  );
  for (const item of waiting.rows) {
    const tick = await deps.quote(item.instrument).catch(() => null);
    if (tick && now - Date.parse(tick.time) <= 30_000) await activateStraddle(item.straddle_id, tick, deps);
  }

  const inFlight = await deps.db.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE status='TRIGGERING' AND metadata->>'mode'='news'`,
  );
  for (const row of inFlight.rows) {
    const meta = metaOf(row);
    const clientId = `gx-${meta.clientRequestId ?? `news-${row.id}`}`;
    const order = await deps.broker.orderByClientId(clientId).catch(() => undefined);
    if (order === undefined) continue; // broker unreachable: try again next sweep
    // Measured from when the order was claimed for sending (server clock).
    const submittedAt = Date.parse(String((row.metadata as { submittedAt?: string } | null)?.submittedAt ?? row.triggered_at ?? row.updated_at));
    const decision = reconcileDecision({
      sinceUpdateMs: now - submittedAt,
      ageMs: now - submittedAt,
      order,
      reconcileAfterMs: RECONCILE_AFTER_MS,
      giveUpAfterMs: GIVE_UP_AFTER_MS,
    });
    if (decision === "wait") continue;
    reconciled += 1;
    if (decision === "filled" && order?.tradeId) {
      const state = await deps.broker.tradeState(order.tradeId).catch(() => null);
      await recordNewsFill(row, order.tradeId, state?.entryPrice ?? order.fillPrice ?? Number(row.trigger_price), null, deps);
    } else if (decision === "rejected") {
      await failInFlight(row, "OANDA cancelled the order without a fill (most often the price bound). Not chased.", "news_missed_bound", deps);
      await emit(row, "missed_bound", `${displayPair(row.instrument)} news order not filled`, "OANDA cancelled the order without a fill — most often because price moved past the slippage bound. Nothing is open; not chased.", deps);
    } else {
      await failInFlight(row, "No answer from OANDA and no order found under this request's id. Nothing was opened; it was not resent.", "news_lost", deps);
      await emit(row, "rejected", `${displayPair(row.instrument)} news order not placed`, "OANDA never confirmed the order and has no record of it. Nothing is open; GX does not resend.", deps);
    }
  }

  const exits = await deps.db.query<PendingEntryRow>(
    `SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries
      WHERE status='TRIGGERED' AND metadata->>'mode'='news' AND paper_trade_id IS NOT NULL
        AND metadata->>'timeExitAt' IS NOT NULL AND (metadata->>'timeExitAt')::timestamptz <= $1
        AND COALESCE(metadata->>'timeExitState','') NOT IN ('done','not_needed')`,
    [new Date(now)],
  );
  for (const row of exits.rows) {
    const trade = (await deps.db.query<{ status: string; entry: string; stop: string }>(
      "SELECT status, entry::text AS entry, stop::text AS stop FROM paper_trades WHERE id=$1",
      [row.paper_trade_id],
    )).rows[0];
    if (trade?.status !== "open") {
      await deps.db.query("UPDATE pending_manual_entries SET metadata=metadata||'{\"timeExitState\":\"not_needed\"}'::jsonb WHERE id=$1", [row.id]);
      continue;
    }
    // Claim the exit so two sweeps never both act; a stale claim (crash mid-close) is retried.
    const claimed = await deps.db.query(
      `UPDATE pending_manual_entries SET metadata=metadata||jsonb_build_object('timeExitState','closing','timeExitClaimedAt',$2::text),updated_at=now()
        WHERE id=$1 AND status='TRIGGERED'
          AND (COALESCE(metadata->>'timeExitState','')='' OR (metadata->>'timeExitState'='closing' AND (metadata->>'timeExitClaimedAt')::timestamptz < $3))`,
      [row.id, new Date(now).toISOString(), new Date(now - TIME_EXIT_RETRY_MS)],
    );
    if (claimed.rowCount !== 1) continue;
    const tradeId = metaOf(row).brokerTradeId;
    if (!tradeId) continue;
    const before = await deps.broker.tradeState(tradeId).catch(() => null);
    if (before?.closed) {
      // Stop or target got there first; the order reconciler books that close.
      await deps.db.query("UPDATE pending_manual_entries SET metadata=metadata||'{\"timeExitState\":\"not_needed\"}'::jsonb WHERE id=$1", [row.id]);
      continue;
    }
    try {
      await deps.broker.closeTrade(tradeId);
    } catch (error) {
      console.error(`[news-straddle] time exit close failed for ${tradeId}`, error);
      continue; // the claim goes stale and is retried
    }
    const after = await deps.broker.tradeState(tradeId).catch(() => null);
    const entry = Number(trade.entry);
    const exit = after?.averageClosePrice ?? null;
    const pl = after?.realizedPL ?? null;
    const resultR = exit === null ? null : manualBrokerCloseResultR({ direction: row.direction, entry, stop: Number(trade.stop), exit });
    const result = pl === null ? (resultR === null ? "breakeven" : resultR > 0 ? "win" : resultR < 0 ? "loss" : "breakeven") : pl > 0 ? "win" : pl < 0 ? "loss" : "breakeven";
    await deps.db.query(
      `UPDATE paper_trades SET status='closed',result=$2,exit=$3,result_r=$4,paper_pl=$5,closed_at=$6,updated_at=now() WHERE id=$1 AND status='open'`,
      [row.paper_trade_id, result, exit ?? entry, resultR, pl, after?.closeTime ?? new Date(now).toISOString()],
    );
    await deps.db.query("UPDATE pending_manual_entries SET metadata=metadata||'{\"timeExitState\":\"done\"}'::jsonb WHERE id=$1", [row.id]);
    timeExits += 1;
    const instrument = row.instrument;
    await emit(row, "time_exit", `${displayPair(instrument)} news trade closed on time`,
      `${metaOf(row).closeAfterMinutes} minutes passed without stop or target, so GX closed it at market${exit === null ? "" : ` at ${fmt(instrument, exit)}`}`
      + `${resultR === null ? "" : ` (${resultR >= 0 ? "+" : ""}${resultR.toFixed(2)}R)`}${pl === null ? "" : `, P/L ${pl >= 0 ? "+" : ""}${pl.toFixed(2)}`}.`, deps, row.id);
  }
  await refreshArmedNewsStraddles(deps);
  return { disarmed, reconciled, timeExits };
}

/** Cancel a whole straddle (both lines) for the user. Returns the rows it cancelled. */
export async function cancelNewsStraddle(userId: string, straddleId: string, deps: NewsDeps = liveNewsDeps) {
  const rows = await deps.db.tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`news-straddle:${straddleId}`]);
    return (await client.query<PendingEntryRow>(
      `UPDATE pending_manual_entries SET status='CANCELLED',cancelled_at=now(),metadata=metadata||'{"execution":"news_cancelled"}'::jsonb,updated_at=now()
        WHERE user_id=$1 AND metadata->>'straddleId'=$2 AND status='PENDING' RETURNING ${PENDING_ENTRY_FIELDS}`,
      [userId, straddleId],
    )).rows;
  });
  if (!rows.length) throw new Error("This news setup already fired or ended, so there is nothing to cancel.");
  forgetStraddle(rows[0]!.instrument, straddleId);
  await emit(rows[0]!, "disarmed", `${displayPair(rows[0]!.instrument)} news setup cancelled`, "You cancelled it. Both lines are off; no order was sent.", deps);
  return rows.map(serializePendingManualEntry);
}
