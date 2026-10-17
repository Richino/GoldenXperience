import type { ChartBox } from "../../components/charts/chart-box-primitive";
import { pipSizeFor, precisionFor } from "../instruments/catalog";
import type { PendingManualEntry } from "../../types/pending-entry";

/**
 * What the chart draws for News-mode setups, from the server's state alone.
 * The server owns the lifecycle (api-server/src/news-straddle.ts); this only
 * reads metadata.newsState, the locked zones and the fill, so the chart never
 * shows a state the server is not in.
 *
 * Kept deliberately quiet for a phone: each zone is its shaded box plus ONE
 * line at the edge where it triggers, tagged "BUY 210.700" / "SELL 210.500".
 * The state shows in the style, not in words (countdowns, the anchor and
 * the worst fill live in the setup's status panel):
 *
 *   ARMED / LOCKING   both zones faded, dashed lines, following the live price
 *   ZONES_LOCKED      both zones solid at the frozen prices
 *   WATCHING          same zones, thicker lines, tagged "· live" (entries open)
 *   reserved / sent   chosen side "BUY 210.695 · sending", other side greyed, no tag
 *   FILLED / CLOSING  the chosen zone kept faded for reference (fill/SL/TP lines come from the trade)
 *   CLOSED            the chosen zone archived, only when that trade is the one being viewed
 *   SKIPPED / EXPIRED / CANCELLED / ORDER_REJECTED / ERROR   nothing
 *
 * A draft (the ticket's unsaved settings) is drawn like a preview and
 * tagged "draft", so it can never be mistaken for a setup the server holds.
 */

export type NewsZones = { buy: { lower: number; upper: number }; sell: { lower: number; upper: number } };
export type NewsOverlayLine = { key: string; price: number; label: string; color: string; textColor: string; dashed: boolean; lineWidth: 1 | 2; entryId: string };
export type NewsDraft = { distancePips: number; depthPips: number; buyEntry?: number; sellEntry?: number };

export const NEWS_BUY_COLOR = "#00b377";
export const NEWS_SELL_COLOR = "#e5484d";
const MUTED = "#8c8c93";

type NewsMeta = {
  configVersion?: number;
  mode?: string;
  straddleId?: string;
  line?: "upper" | "lower";
  newsState?: string;
  execution?: string;
  distancePips?: number;
  slippagePips?: number;
  zones?: NewsZones | null;
  anchor?: number | null;
  lockAt?: string;
  release?: { time?: string } | null;
  reservation?: { side?: "long" | "short" } | null;
  exitReason?: string;
  resultR?: number | null;
};

const metaOf = (entry: PendingManualEntry) => (entry.metadata ?? {}) as NewsMeta;

/** The state the server reports; rows from before the state machine map to the nearest one. */
export function newsStateOf(entry: PendingManualEntry) {
  const meta = metaOf(entry);
  if (meta.configVersion === 3 && meta.newsState) {
    const mapped: Record<string, string> = { SCHEDULED: "ARMED", PREPARING: "LOCKING", READY: "ZONES_LOCKED", SUBMITTING: "WATCHING", PENDING_ORDERS: "WATCHING", OCO_CANCELLING: "FILLED", OPEN: "FILLED", TRAILING: "FILLED", CANCELLING: "CLOSING", EXCEPTION: "ERROR", HALTED: "ENDED" };
    return mapped[meta.newsState] ?? meta.newsState;
  }
  if (meta.newsState) return meta.newsState;
  if (entry.status === "PENDING") return meta.execution === "news_waiting" ? "ARMED" : "WATCHING";
  if (entry.status === "TRIGGERING") return "ORDER_SUBMITTING";
  if (entry.status === "TRIGGERED") return entry.paperTradeStatus === "closed" ? "CLOSED" : "FILLED";
  return "ENDED";
}

/** Zones around an anchor, rounded to the instrument's precision (ascending bounds). */
export function zonesAround(instrument: string, anchor: number, distancePips: number, depthPips: number): NewsZones {
  const pip = pipSizeFor(instrument);
  const precision = precisionFor(instrument);
  const r = (value: number) => Number(value.toFixed(precision));
  const buyLower = r(anchor + distancePips * pip);
  const sellUpper = r(anchor - distancePips * pip);
  return { buy: { lower: buyLower, upper: r(buyLower + depthPips * pip) }, sell: { lower: r(sellUpper - depthPips * pip), upper: sellUpper } };
}


export function newsZoneOverlay(input: {
  instrument: string;
  entries: PendingManualEntry[];
  /** Live mid, already rounded (to the pip) by the caller so previews don't redraw on every tick. */
  liveMid: number | null;
  now: number;
  /** The ticket's unsaved settings, while the News ticket is open. */
  draft: NewsDraft | null;
  /** Journal trade being viewed: a CLOSED setup is shown only for its own trade. */
  viewedPaperTradeId: string | null;
  formatPrice: (price: number) => string;
}): { boxes: ChartBox[]; lines: NewsOverlayLine[] } {
  const boxes: ChartBox[] = [];
  const lines: NewsOverlayLine[] = [];
  const fmt = input.formatPrice;
  const startOf = (createdAt: string) => new Date(Math.min(Date.parse(createdAt), input.now) - 3 * 60 * 60_000).toISOString();

  const groups = new Map<string, PendingManualEntry[]>();
  for (const entry of input.entries) {
    const meta = metaOf(entry);
    if (meta.mode !== "news" || !meta.straddleId || entry.instrument !== input.instrument) continue;
    groups.set(meta.straddleId, [...(groups.get(meta.straddleId) ?? []), entry]);
  }

  const drawZone = (key: string, side: "buy" | "sell", zone: { lower: number; upper: number }, opts: {
    tag?: string; color: string; faded: boolean; dashed: boolean; start: string; end: string; entryId: string; strong?: boolean;
  }) => {
    // The box shows the zone; one line at the edge where it triggers names it.
    boxes.push({ key: `news-box-${key}-${side}`, startTime: opts.start, endTime: opts.end, top: zone.upper, bottom: zone.lower, color: opts.color, faded: opts.faded });
    const entryEdge = side === "buy" ? zone.lower : zone.upper;
    lines.push({
      key: `news-edge-${key}-${side}`, price: entryEdge, label: `${side === "buy" ? "BUY" : "SELL"} ${fmt(entryEdge)}${opts.tag ? ` · ${opts.tag}` : ""}`,
      color: opts.color, textColor: "#ffffff", dashed: opts.dashed, lineWidth: opts.strong ? 2 : 1, entryId: opts.entryId,
    });
  };

  let hasLiveSetup = false;
  for (const [straddleId, group] of groups) {
    const upper = group.find((entry) => metaOf(entry).line === "upper") ?? group.find((entry) => entry.direction === "long");
    const lower = group.find((entry) => metaOf(entry).line === "lower") ?? group.find((entry) => entry.direction === "short");
    if (!upper || !lower) continue;
    const meta = metaOf(upper);
    const state = newsStateOf(group.find((entry) => entry.status === "TRIGGERING" || entry.status === "TRIGGERED") ?? upper);
    const start = startOf(upper.createdAt);
    const end = upper.expiresAt ?? new Date(input.now + 60 * 60_000).toISOString();
    const lockedZones = meta.zones ?? null;

    if (state === "ARMED" || state === "LOCKING") {
      hasLiveSetup = true;
      if (meta.configVersion !== 3 && (input.liveMid === null || !meta.distancePips || meta.slippagePips === undefined)) continue;
      const preview = meta.configVersion === 3 ? lockedZones : zonesAround(input.instrument, input.liveMid!, meta.distancePips!, meta.slippagePips!);
      if (!preview) continue;
      drawZone(straddleId, "buy", preview.buy, { color: NEWS_BUY_COLOR, faded: true, dashed: true, start, end, entryId: upper.id });
      drawZone(straddleId, "sell", preview.sell, { color: NEWS_SELL_COLOR, faded: true, dashed: true, start, end, entryId: lower.id });
      continue;
    }
    if (!lockedZones) continue;
    if (state === "ZONES_LOCKED" || state === "WATCHING") {
      hasLiveSetup = true;
      const tag = state === "WATCHING" ? "live" : undefined;
      drawZone(straddleId, "buy", lockedZones.buy, { tag, color: NEWS_BUY_COLOR, faded: false, dashed: false, start, end, entryId: upper.id, strong: state === "WATCHING" });
      drawZone(straddleId, "sell", lockedZones.sell, { tag, color: NEWS_SELL_COLOR, faded: false, dashed: false, start, end, entryId: lower.id, strong: state === "WATCHING" });
      continue;
    }
    const side = meta.reservation?.side ?? (group.find((entry) => entry.status === "TRIGGERING" || entry.status === "TRIGGERED")?.direction ?? null);
    if (!side) continue;
    const chosen = side === "long" ? "buy" : "sell";
    const other = side === "long" ? "sell" : "buy";
    const chosenEntry = side === "long" ? upper : lower;
    const color = side === "long" ? NEWS_BUY_COLOR : NEWS_SELL_COLOR;
    if (state === "TRIGGER_RESERVED" || state === "ORDER_SUBMITTING" || state === "ORDER_UNKNOWN") {
      hasLiveSetup = true;
      drawZone(straddleId, chosen, lockedZones[chosen], { tag: state === "ORDER_UNKNOWN" ? "checking" : "sending", color, faded: false, dashed: false, start, end, entryId: chosenEntry.id, strong: true });
      boxes.push({ key: `news-box-${straddleId}-${other}`, startTime: start, endTime: end, top: lockedZones[other].upper, bottom: lockedZones[other].lower, color: MUTED, faded: true });
      continue;
    }
    if (state === "FILLED" || state === "CLOSING") {
      boxes.push({ key: `news-box-${straddleId}-${chosen}`, startTime: start, endTime: new Date(input.now + 30 * 60_000).toISOString(), top: lockedZones[chosen].upper, bottom: lockedZones[chosen].lower, color, faded: true });
      continue;
    }
    if (state === "CLOSED" && input.viewedPaperTradeId !== null && chosenEntry.paperTradeId === input.viewedPaperTradeId) {
      boxes.push({ key: `news-box-${straddleId}-${chosen}`, startTime: start, endTime: chosenEntry.updatedAt, top: lockedZones[chosen].upper, bottom: lockedZones[chosen].lower, color: MUTED, faded: true });
    }
  }

  // The ticket's unsaved settings, only while no setup is live on the pair.
  if (input.draft && !hasLiveSetup && input.liveMid !== null && input.draft.distancePips > 0 && input.draft.depthPips > 0) {
    const depth = input.draft.depthPips * pipSizeFor(input.instrument);
    const draft = input.draft.buyEntry !== undefined && input.draft.sellEntry !== undefined
      ? { buy: { lower: input.draft.buyEntry, upper: input.draft.buyEntry + depth }, sell: { lower: input.draft.sellEntry - depth, upper: input.draft.sellEntry } }
      : zonesAround(input.instrument, input.liveMid, input.draft.distancePips, input.draft.depthPips);
    const start = startOf(new Date(input.now).toISOString());
    const end = new Date(input.now + 60 * 60_000).toISOString();
    drawZone("draft", "buy", draft.buy, { tag: "draft", color: NEWS_BUY_COLOR, faded: true, dashed: true, start, end, entryId: "" });
    drawZone("draft", "sell", draft.sell, { tag: "draft", color: NEWS_SELL_COLOR, faded: true, dashed: true, start, end, entryId: "" });
  }
  return { boxes, lines };
}
