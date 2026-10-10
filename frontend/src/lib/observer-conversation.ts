import type { ObserverPlan, ObserverRead, ObserverSnapshot } from "./market-observer-types";
import { precisionFor } from "./instruments/catalog";
import { getForexSessionStatus } from "./strategy/session";

export interface ObserverChatMessage {
  id: string; instrument: string; at: string; role: "user" | "observer";
  kind: "request" | "read" | "plan" | "connection" | "explanation";
  text: string; source?: "rules" | "model";
  evidence?: Array<{ id: string; text: string }>;
}
type Draft = Omit<ObserverChatMessage, "id" | "role">;
export function observerSnapshotCanReplace(previous: ObserverSnapshot | null | undefined, next: ObserverSnapshot, instrument: string): boolean {
  if (next.read && (next.read.instrument !== instrument || !Number.isFinite(Date.parse(next.read.asOf))) || next.plan && next.plan.instrument !== instrument) return false;
  if (previous?.read && next.read && Date.parse(next.read.asOf) < Date.parse(previous.read.asOf)) return false;
  if (previous?.plan && next.plan) {
    if (next.plan.version < previous.plan.version) return false;
    if (next.plan.version === previous.plan.version && (next.plan.id !== previous.plan.id || Date.parse(next.plan.updatedAt) < Date.parse(previous.plan.updatedAt)
      || ["CLOSED", "EXPIRED", "INVALIDATED"].includes(previous.plan.status) && !["CLOSED", "EXPIRED", "INVALIDATED"].includes(next.plan.status))) return false;
  }
  return true;
}
const label = (pair: string) => pair.replace("_", "/");
const activePatterns = (read?: ObserverRead) => read?.patterns.filter(p => !p.historical && p.contextState === "current") ?? [];
const readKey = (read?: ObserverRead) => read ? JSON.stringify([read.state, read.lean, read.pressure.direction, read.pressure.relation, read.blockers,
  activePatterns(read).map(p => [p.id, p.state]).sort()]) : "";
const planKey = (plan: ObserverPlan | null) => plan ? JSON.stringify([plan.id, plan.status, plan.confirmationCandle, plan.triggeredAt, plan.outcome]) : "";
const aiKey = (read?: ObserverRead) => read?.ai.source === "model" && read.ai.text ? JSON.stringify([read.revision, read.ai.text, read.ai.watch]) : "";

/** Conditional guidance from measured state and a frozen hypothesis, never a forecast. */
export function observerDecisionText(snapshot: ObserverSnapshot, instrument: string): string {
  if (!snapshot.enabled) return snapshot.reason ?? "Live monitoring is unavailable for this pair.";
  const read = snapshot.read, plan = snapshot.plan;
  if (!read) return "Live observations are unavailable. A fresh read is required.";
  const marketClosed = !getForexSessionStatus(new Date(read.asOf)).marketOpen;
  const parts: string[] = [];
  if (marketClosed || read.state !== "live") {
    if (marketClosed) {
      parts.push("Forex market closed. Live price analysis is paused.");
      parts.push("Watching resumes after the market reopens with fresh prices, candle context, and news checks.");
    } else {
      parts.push(read.state === "paused" ? "Live analysis is paused." : "Building a fresh price-movement window.");
      parts.push(read.blockers[0] ?? "Fresh price observations are required.");
      parts.push("The next live decision requires fresh prices, candle context, and news checks.");
    }
  } else {
    parts.push(read.lean === "up" ? "Leaning up: bullish continuation is the scenario to watch."
      : read.lean === "down" ? "Leaning down: bearish continuation is the scenario to watch."
      : read.lean === "range" ? "Price is ranging; there is no persistent directional lean."
      : read.lean === "conflicting" ? "H1 and H4 disagree; direction is unresolved."
      : "There is not enough current evidence for a directional lean.");
    parts.push(read.facts.find(f => f.id === "quote-pressure")?.text ?? "Short-term pressure is unknown.");
    if (read.pressure.relation === "opposed") parts.push("This can be a pullback or a reversal. A candle confirmation must resolve it.");
    if (read.blockers.length) parts.push(`Entry checks are blocked: ${read.blockers.join(" ")}`);
    const patterns = activePatterns(read).slice(0, 2);
    if (patterns.length) parts.push(`Detected ${patterns.map(p => `${p.timeframe} ${p.kind.replaceAll("_", " ")} (${p.state})`).join("; ")}. Forming shapes can change.`);
  }
  if (plan) {
    const price = (n: number) => n.toFixed(precisionFor(instrument));
    if (plan.outcome) parts.push(`Plan ${plan.version}: ${plan.outcome.kind.replaceAll("_", " ")}${plan.outcome.price !== null ? ` at ${price(plan.outcome.price)}` : "; intervening outcome is not inferred"}.`);
    else if (plan.triggeredAt) parts.push(`Plan ${plan.version}: ${plan.direction} condition was observed at ${price(plan.observedEntry!)}. ${plan.reason}`);
    else if (["INVALIDATED", "EXPIRED", "CLOSED"].includes(plan.status)) parts.push(`Plan ${plan.version} is ${plan.status.toLowerCase()}. ${plan.reason}`);
    else if (plan.direction && plan.trigger && plan.zone) {
      parts.push(`Watch ${plan.direction}: a new ${plan.trigger.timeframe} candle must close ${plan.direction === "long" ? "above" : "below"} ${price(plan.trigger.boundary)}, with executable price inside ${price(plan.zone.low)}–${price(plan.zone.high)}.`);
      if (plan.stop !== null && plan.target !== null) parts.push(`Stop ${price(plan.stop)}; target ${price(plan.target)}. ${plan.invalidation}`);
      parts.push(`Entry expires ${new Date(plan.expiresAt).toISOString()}. ${snapshot.checks?.some(c => c.id === "confirmation" && c.state === "met") ? "Candle confirmed; the remaining entry checks must pass." : "Awaiting a valid closed-candle confirmation and passing entry checks."}`);
    } else parts.push(`Watch condition: ${plan.reason} ${plan.invalidation}`);
  }
  if (!marketClosed && read.state === "live" && !plan?.triggeredAt) parts.push("A lean is a scenario, not a confirmed entry.");
  return parts.join(" ");
}

interface PairCursor { snapshot: ObserverSnapshot | null; failed: boolean; lastReadAt: number; pending: boolean; seenEvents: Set<string> }
/** Bounded session cursors suppress repeated polls; important lifecycle events bypass chatter cooldown. */
export class ObserverConversation {
  private pairs = new Map<string, PairCursor>();
  reset(instrument: string) { this.pairs.delete(instrument); }
  private cursor(instrument: string) {
    let cursor = this.pairs.get(instrument);
    if (!cursor) { cursor = { snapshot: null, failed: false, lastReadAt: -Infinity, pending: false, seenEvents: new Set() }; this.pairs.set(instrument, cursor); }
    return cursor;
  }
  failure(instrument: string, at: string): Draft[] {
    const cursor = this.cursor(instrument);
    if (cursor.failed) return [];
    cursor.failed = true;
    return [{ instrument, at, kind: "connection", text: "Connection interrupted. New live chat observations are paused; unseen movement is not inferred.", source: "rules" }];
  }
  ingest(instrument: string, next: ObserverSnapshot, receivedAt: string): Draft[] {
    const cursor = this.cursor(instrument), previous = cursor.snapshot;
    // An older response must not replace a later read or a newly saved plan.
    if (!observerSnapshotCanReplace(previous, next, instrument)) return [];
    const drafts: Draft[] = [], at = next.read?.asOf ?? receivedAt, now = Date.parse(receivedAt);
    const resumed = cursor.failed;
    if (resumed) drafts.push({ instrument, at, kind: "connection", text: "Connection restored. This is the latest measured state; movement missed by the chat is not reconstructed.", source: "rules" });
    cursor.failed = false;
    const lifecycleChanged = planKey(previous?.plan ?? null) !== planKey(next.plan);
    const feedChanged = previous?.read?.state !== next.read?.state || previous?.enabled !== next.enabled;
    // Server journal events preserve fast trigger/close transitions between UI polls.
    const events = previous ? next.history.filter(e => !cursor.seenEvents.has(e.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(a.id) - Number(b.id)) : [];
    for (const e of next.history) cursor.seenEvents.add(e.id);
    if (cursor.seenEvents.size > 120) cursor.seenEvents = new Set(next.history.map(e => e.id));
    if (readKey(previous?.read) !== readKey(next.read)) cursor.pending = true;
    const planSummary = lifecycleChanged && (previous?.plan?.id !== next.plan?.id || next.plan?.status !== "PAUSED" || !events.length && previous?.read?.state !== "paused");
    const summary = !previous || resumed || planSummary || feedChanged || cursor.pending && now - cursor.lastReadAt >= 10_000;
    for (const event of events) {
      // A plan snapshot can reach the browser before its queued journal row.
      // Do not announce that same transition again when storage catches up.
      if (previous?.plan?.id === next.plan?.id && event.status === previous?.plan?.status && Date.parse(event.at) <= Date.parse(previous.plan.updatedAt)) continue;
      // A current-state summary already describes this final transition. Keep
      // intervening events (for example a fast trigger followed by a close).
      if (summary && event === events.at(-1) && event.status === next.plan?.status && event.reason === next.plan.reason) continue;
      drafts.push({ instrument, at: event.at, kind: "plan", source: "rules", text: `Plan ${next.plan?.version ?? ""}: ${event.status.toLowerCase()}. ${event.reason}` });
    }
    if (summary) {
      drafts.push({ instrument, at, kind: lifecycleChanged && previous ? "plan" : "read", text: observerDecisionText(next, instrument), source: "rules", evidence: next.read?.facts.map(f => ({ id: f.id, text: f.text })) });
      cursor.lastReadAt = now; cursor.pending = false;
    }
    if (next.read?.state === "live" && next.read.ai.state === "ready" && aiKey(next.read) && aiKey(next.read) !== aiKey(previous?.read)) drafts.push({ instrument, at: next.read.ai.at ?? at,
      kind: "explanation", source: "model", text: `${next.read.ai.text}${next.read.ai.watch ? ` Watch: ${next.read.ai.watch}` : ""}`, evidence: next.read.ai.evidence });
    cursor.snapshot = structuredClone(next);
    return drafts;
  }
}

export const observerPairLabel = label;
