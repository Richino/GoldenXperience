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
const readKey = (read?: ObserverRead) => read ? JSON.stringify([read.state, read.lean, read.pressure.relation,
  read.story && [read.story.broader.direction, read.story.recent.direction, read.story.current.levels.map(l => [l.role, l.state])],
  activePatterns(read).map(p => [p.kind, p.timeframe, p.state]).sort()]) : "";
const planKey = (plan: ObserverPlan | null) => plan ? JSON.stringify([plan.id, ["PAUSED", "READY", "WATCHING"].includes(plan.status) ? "monitoring" : plan.status, plan.pullback?.touchedAt, plan.confirmationCandle, plan.triggeredAt, plan.outcome,
  plan.consolidation?.attempts.map(a => [a.hold.at, a.hold.outcome, a.candle.at, a.candle.outcome])]) : "";

/**
 * Short rule-based chat updates, written the way a person watching the chart
 * would say them: the first sentence is the headline, the rest is the plain
 * follow-up. They describe what price is doing now, never what it will do.
 * `variant` rotates the wording when the same situation is reported again
 * ("Still waiting…"), so a long wait doesn't read as the same line over and
 * over; variant 0 is the standard phrasing. Full reasoning belongs in Plan & results.
 */
export function observerChatText(snapshot: ObserverSnapshot, instrument: string, variant = 0): string {
  const read = snapshot.read, plan = snapshot.plan;
  const price = (n: number) => n.toFixed(precisionFor(instrument));
  const side = plan?.direction === "long" ? "buy" : "sell";
  const say = (...lines: string[]) => lines[Math.abs(variant) % lines.length];
  if (!snapshot.enabled || !read) return "I can't watch this pair right now. Open Plan & results to see why.";
  if (plan?.outcome) return ({
    target_observed: "Target hit. Price reached the profit target on this paper plan.",
    stop_observed: "Stopped out. Price reached the stop on this paper plan.",
    unknown_after_gap: "I lost the price feed for a while. I can't tell how this plan ended, so I'm not guessing.",
    monitoring_stopped: "I've stopped watching this plan.",
  })[plan.outcome.kind];
  if (plan && ["INVALIDATED", "EXPIRED", "CLOSED"].includes(plan.status)) return plan.status === "INVALIDATED"
    ? "This setup is off. Price broke the level that kept it valid. Run Analyze for a fresh plan."
    : plan.status === "EXPIRED"
      ? "This setup ran out of time without an entry. Run Analyze when you want a new one."
      : "This plan is finished.";
  if (plan?.triggeredAt) return `Entry conditions met${plan.observedEntry !== null ? ` at ${price(plan.observedEntry)}` : ""}. This is a paper ${side} signal, not a real order.`;
  if (!getForexSessionStatus(new Date(read.asOf)).marketOpen) return say(
    "The market's closed. I'll pick this back up when it reopens.",
    "Still closed. I'll jump back in as soon as prices start moving.",
    "Market's still shut. Nothing to watch until it opens.",
  );
  if (read.state === "paused") return say(
    "Prices stopped coming in. Your plan is safe; I'm waiting for fresh prices.",
    "Still no fresh prices. Your plan hasn't changed while I wait.",
    "The price feed's still quiet. I'll pick it up the moment it's back.",
    "Still waiting on live prices. Nothing about your plan has moved.",
  );
  if (read.state === "warming") return say(
    "Getting fresh prices. Give me a moment; your plan stays as it is.",
    "Almost there. Still gathering a few seconds of live prices.",
    "Still warming up on live prices. Your plan is unchanged.",
  );
  if (snapshot.checks?.some(c => c.id === "confirmation" && c.state === "met")) return say(
    "The candle confirmed. A few entry checks still need to pass before it counts.",
    "Candle's confirmed. Still waiting on the last entry checks.",
    "Still just the candle confirmation. The entry checks still need to pass before it counts.",
  );
  const attempt = plan?.consolidation?.attempts.at(-1);
  if (attempt && !attempt.endedAt) {
    const edge = attempt.side === "up" ? "top" : "bottom";
    if (attempt.candle.at) return `A 5-minute candle just closed past the ${edge} of the range. ${attempt.candle.blockers.length ? "The entry checks still say no, though." : "That's a paper breakout; take a look at the plan."}`;
    if (attempt.hold.at) return say(
      `Price is holding past the ${edge} of the range. I'm waiting for the 5-minute candle to close there.`,
      `Still holding past the ${edge} edge. The 5-minute close will settle it.`,
      `Price is staying outside the ${edge} of the range. Still waiting on the candle close.`,
    );
    return say(
      `Price is pushing at the ${edge} of the range. It hasn't broken out yet.`,
      `Still testing the ${edge} edge. No breakout so far.`,
      `Price keeps leaning on the ${edge} of the range. It hasn't cleared it.`,
    );
  }
  if (attempt?.endedAt && [attempt.hold.outcome, attempt.candle.outcome].includes("returned_inside")) return "That breakout didn't hold. Price slipped back inside the range.";
  if (plan?.pullback && plan.direction) {
    const zone = `${price(plan.pullback.zone.low)}–${price(plan.pullback.zone.high)}`;
    const toward = plan.direction === "long" ? "dip" : "rise";
    if (plan.pullback.phase === "testing") return say(
      `Price is in the ${side} area (${zone}) now. I'm watching how it reacts before anything counts.`,
      `Still inside the ${side} area. Waiting to see whether it turns.`,
      `Price is still sitting in the ${side} area at ${zone}. No reaction worth acting on yet.`,
      `Still in the zone. I want to see it turn before anything counts.`,
    );
    if (plan.pullback.phase === "rebounding") return say(
      `Price is bouncing off the ${side} area. I'm waiting for a candle to close and confirm it.`,
      `The bounce is still going. A candle close will tell us if it's real.`,
      `Price is still moving away from the ${side} area. Waiting on the candle to confirm.`,
    );
    if (plan.consolidation?.state === "inside") return say(
      `Price is still boxed in between ${price(plan.consolidation.low)} and ${price(plan.consolidation.high)}. I'm waiting for it to break out of that range.`,
      `Still stuck in the ${price(plan.consolidation.low)}–${price(plan.consolidation.high)} range. No breakout yet.`,
      `Same tight range as before. I'm watching both edges.`,
      `Price keeps drifting inside the range. Nothing has broken out.`,
    );
    return say(
      `Waiting for price to ${toward} into the ${side} area at ${zone}. Nothing to do yet.`,
      `Still waiting for that ${toward} into ${zone}. Nothing to do yet.`,
      `No change. The ${side} area at ${zone} is still untouched.`,
      `Still a way off the ${side} area. I'll let you know when price gets there.`,
      `Price hasn't made it to ${zone} yet. Still watching.`,
    );
  }
  if (plan?.consolidation) {
    if (plan.consolidation.state === "unavailable") return "I'm missing some price updates. The range stays as it was; nothing is confirmed.";
    if (plan.consolidation.state === "expired") return "The range check timed out with no breakout. Run Analyze for a new setup.";
    return say(
      `Price is moving sideways between ${price(plan.consolidation.low)} and ${price(plan.consolidation.high)}. I'm watching both edges.`,
      `Still ranging between ${price(plan.consolidation.low)} and ${price(plan.consolidation.high)}. No break either way.`,
      `Still sideways. Both edges of the range are holding.`,
    );
  }
  if (read.pressure.relation === "opposed") return say(
    "The short-term move is going against the bigger trend. It could be a pullback or a turn; nothing is confirmed.",
    "Price is still pushing against the bigger trend. Nothing is confirmed either way.",
    "The short-term move still disagrees with the trend. I'm not reading anything into it yet.",
  );
  const patterns = activePatterns(read).filter(p => p.state === "confirmed");
  if (patterns.length) return `I spotted a ${patterns[0].timeframe} ${patterns[0].kind.replaceAll("_", " ")}. On its own, that isn't a reason to enter.`;
  if (read.lean === "up") return say("Price is leaning up. No setup worth taking yet.", "Still leaning up. Nothing worth taking so far.", "The lean is still upward, but there's no setup yet.");
  if (read.lean === "down") return say("Price is leaning down. No setup worth taking yet.", "Still leaning down. Nothing worth taking so far.", "The lean is still downward, but there's no setup yet.");
  if (read.lean === "range") return say("Price is moving sideways. I'm waiting for it to pick a direction.", "Still sideways. No direction yet.", "Price is still drifting without a direction. Nothing to act on.");
  return say("There's no clear direction right now. Nothing to act on yet.", "Still no clear direction. I'm keeping watch.", "The picture is still mixed. Nothing worth acting on.");
}

/** Keep legacy session messages compact without deleting their captured evidence. */
export function compactObserverChatMessage(text: string): string {
  if (text.length <= 280) return text;
  if (text.startsWith("Bigger picture") || text.startsWith("Leaning ") || text.startsWith("Price is ranging")) return "Chart context updated. Open Plan & results for the full picture.";
  if (text.startsWith("Live analysis is paused")) return "Live prices interrupted. Waiting for fresh updates.";
  return text.slice(0, 240).replace(/\s+\S*$/, "") + "… Full details in Plan & results.";
}

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
    if (read.story) {
      parts.push(`Bigger picture (${read.story.broader.timeframe}, ${read.story.broader.bars} closed candles): ${read.story.broader.summary}`);
      parts.push(`Recent pattern (${read.story.recent.timeframe}): ${read.story.recent.summary}`);
      parts.push(`Now (${read.story.current.timeframe}): ${read.story.current.summary}`);
      parts.push(...read.story.current.levels.map(l => l.condition), read.story.current.watch);
    } else {
    parts.push(read.lean === "up" ? "Leaning up: bullish continuation is the scenario to watch."
      : read.lean === "down" ? "Leaning down: bearish continuation is the scenario to watch."
      : read.lean === "range" ? "Price is ranging; there is no persistent directional lean."
      : read.lean === "conflicting" ? "H1 and H4 disagree; direction is unresolved."
      : "There is not enough current evidence for a directional lean.");
    }
    parts.push(read.facts.find(f => f.id === "quote-pressure")?.text ?? "Short-term pressure is unknown.");
    if (read.pressure.relation === "opposed") parts.push("This can be a pullback or a reversal. A candle confirmation must resolve it.");
    if (read.blockers.length) parts.push(`Entry checks are blocked: ${read.blockers.join(" ")}`);
    const patterns = activePatterns(read).slice(0, 2);
    if (patterns.length) parts.push(`Detected ${patterns.map(p => `${p.timeframe} ${p.kind.replaceAll("_", " ")} (${p.state})`).join("; ")}. Forming shapes can change.`);
  }
  if (plan) {
    const price = (n: number) => n.toFixed(precisionFor(instrument));
    if (plan.consolidation) parts.push(`Consolidation comparison: frozen box ${price(plan.consolidation.low)}–${price(plan.consolidation.high)}; ${plan.consolidation.state}. Comparing a ${plan.consolidation.holdSeconds}s hold with follow-through against a new M5 close outside. Experimental paper observations, not an entry instruction.`);
    const attempt = plan.consolidation?.attempts.at(-1);
    if (attempt) parts.push(`Latest ${attempt.side} attempt: hold ${attempt.hold.at ? `observed; ${attempt.hold.outcome.replaceAll("_", " ")}` : "not confirmed"}; M5 close ${attempt.candle.at ? `observed; ${attempt.candle.outcome.replaceAll("_", " ")}` : "not confirmed"}.`);
    if (plan.pullback && plan.direction && !plan.outcome) parts.push(`Frozen ${plan.direction} plan: pullback area ${price(plan.pullback.zone.low)}–${price(plan.pullback.zone.high)}. Monitor: ${plan.pullback.phase}. ${plan.pullback.phase === "unavailable" ? "Fresh broker updates are required; missing movement is not inferred." : "Each received broker update is checked. Touching the area alone is not an entry."}`);
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

interface PairCursor { snapshot: ObserverSnapshot | null; failed: boolean; lastReadAt: number; pending: boolean; seenEvents: Set<string>; recent: Map<string, number>; lastSituation: string; repeats: number }
/** Bounded session cursors suppress repeated polls; important lifecycle events bypass chatter cooldown. */
export class ObserverConversation {
  private pairs = new Map<string, PairCursor>();
  reset(instrument: string) { this.pairs.delete(instrument); }
  private cursor(instrument: string) {
    let cursor = this.pairs.get(instrument);
    if (!cursor) { cursor = { snapshot: null, failed: false, lastReadAt: -Infinity, pending: false, seenEvents: new Set(), recent: new Map(), lastSituation: "", repeats: 0 }; this.pairs.set(instrument, cursor); }
    return cursor;
  }
  failure(instrument: string, at: string): Draft[] {
    const cursor = this.cursor(instrument);
    if (cursor.failed) return [];
    cursor.failed = true;
    const text = "Lost the connection. I'll carry on as soon as prices come back.", now = Date.parse(at);
    if (now - (cursor.recent.get(text) ?? -Infinity) < 120_000) return [];
    cursor.recent.set(text, now);
    return [{ instrument, at, kind: "connection", text, source: "rules" }];
  }
  ingest(instrument: string, next: ObserverSnapshot, receivedAt: string): Draft[] {
    const cursor = this.cursor(instrument), previous = cursor.snapshot;
    // An older response must not replace a later read or a newly saved plan.
    if (!observerSnapshotCanReplace(previous, next, instrument)) return [];
    const drafts: Draft[] = [], at = next.read?.asOf ?? receivedAt, now = Date.parse(receivedAt);
    const resumed = cursor.failed;
    if (resumed && now - cursor.lastReadAt >= 30_000) drafts.push({ instrument, at, kind: "connection", text: "Back online. I couldn't see what price did while the connection was down.", source: "rules" });
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
      if (["WATCHING", "READY", "PAUSED"].includes(event.status)) continue;
      // A plan snapshot can reach the browser before its queued journal row.
      // Do not announce that same transition again when storage catches up.
      if (previous?.plan?.id === next.plan?.id && event.status === previous?.plan?.status && Date.parse(event.at) <= Date.parse(previous.plan.updatedAt)) continue;
      // A current-state summary already describes this final transition. Keep
      // intervening events (for example a fast trigger followed by a close).
      if (summary && event === events.at(-1) && event.status === next.plan?.status && event.reason === next.plan.reason) continue;
      drafts.push({ instrument, at: event.at, kind: "plan", source: "rules", text: compactObserverChatMessage(`Plan ${event.status.toLowerCase()}. ${event.reason}`) });
    }
    // The standard wording names the situation; a repeat of it gets the next
    // phrasing ("Still waiting…") but still counts as the same message for
    // duplicate suppression, so it doesn't post any more often than before.
    const situations = new Map<Draft, string>();
    let summaryDraft: Draft | null = null;
    if (summary) {
      const situation = observerChatText(next, instrument);
      const variant = situation === cursor.lastSituation ? cursor.repeats + 1 : 0;
      const text = observerChatText(next, instrument, variant);
      const important = lifecycleChanged || !previous;
      if (important || now - cursor.lastReadAt >= 30_000) {
        summaryDraft = { instrument, at, kind: lifecycleChanged && previous ? "plan" : "read", text, source: "rules", evidence: next.read?.facts.map(f => ({ id: f.id, text: f.text })) };
        situations.set(summaryDraft, situation);
        drafts.push(summaryDraft);
      }
      if (important || now - cursor.lastReadAt >= 30_000) { cursor.lastReadAt = now; cursor.pending = false; }
    }
    cursor.snapshot = structuredClone(next);
    for (const [text, seenAt] of cursor.recent) if (now - seenAt >= 120_000) cursor.recent.delete(text);
    return drafts.filter(draft => {
      const newPlan = next.plan?.id !== previous?.plan?.id;
      const critical = draft.kind === "plan" && (newPlan || Boolean(next.plan?.triggeredAt) || Boolean(next.plan && ["INVALIDATED", "EXPIRED", "CLOSED"].includes(next.plan.status)));
      const key = situations.get(draft) ?? draft.text;
      if (!critical && cursor.recent.has(key)) return false;
      cursor.recent.set(key, now);
      if (draft === summaryDraft) {
        cursor.repeats = key === cursor.lastSituation ? cursor.repeats + 1 : 0;
        cursor.lastSituation = key;
      }
      return true;
    });
  }
}

export const observerPairLabel = label;
