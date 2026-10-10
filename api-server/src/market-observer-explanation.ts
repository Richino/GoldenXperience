import type { ObserverRead } from "../../frontend/src/lib/market-observer-types.js";

/** Minimum evidence keeps an explanation from overlooking known blockers or contradictions. */
export function requiredObserverEvidence(read: ObserverRead): string[] {
  const ids = new Set<string>();
  const risk = read.facts.find(f => read.blockers.includes(f.text));
  if (risk) ids.add(risk.id);
  if (read.facts.some(f => f.id === "structure-H1")) ids.add("structure-H1");
  if (read.lean === "conflicting" && read.facts.some(f => f.id === "structure-H4")) ids.add("structure-H4");
  if (read.facts.some(f => f.id === "quote-pressure")) ids.add("quote-pressure");
  return [...ids];
}

export function observerExplanationSchema(read: ObserverRead) {
  return { type: "object", additionalProperties: false, required: ["lean", "pressure", "summary", "factIds", "watchIndex"], properties: {
    lean: { type: "string", enum: [read.lean] },
    pressure: { type: "string", enum: [read.pressure.direction] },
    summary: { type: "string", minLength: 20, maxLength: 420 },
    factIds: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", enum: read.facts.map(f => f.id) } },
    watchIndex: { type: "integer", enum: read.changeConditions.map((_, i) => i) },
  } };
}

/** Structural checks reduce errors; they do not prove every paraphrase is semantically faithful. */
export function validateObserverExplanation(raw: unknown, read: ObserverRead): ObserverRead["ai"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Observer explanation was not an object.");
  const value = raw as Record<string, unknown>;
  const keys = ["lean", "pressure", "summary", "factIds", "watchIndex"];
  if (Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !(k in value))) throw new Error("Observer explanation contained unsupported fields.");
  if (value.lean !== read.lean || value.pressure !== read.pressure.direction) throw new Error("Observer explanation changed the measured direction.");
  if (typeof value.summary !== "string" || value.summary.trim().length < 20 || value.summary.length > 420) throw new Error("Observer explanation exceeded its text limits.");
  const text = value.summary.trim();
  // Numbers belong in the measured evidence, never in generated prose or proposed levels.
  const prose = text.replace(/\b(?:M1|M5|M15|H1|H4)\b/g, "");
  if (/[\d%$€£¥<>`]|https?:|www\./i.test(prose) || /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i.test(prose)) throw new Error("Observer explanation included a number, markup or link.");
  if (/\b(?:probabilit\w*|odds|confidence|chance|percent|guarantee\w*|certain\w*|sure|predict\w*|forecast\w*|expect\w*|likely|will|buy|sell|buyers?|sellers?|institution\w*|manipulat\w*)\b|win[ -]?rate|order[ -]?flow|stop[ -]?hunt|\b(?:go|take|enter|open) (?:a )?(?:long|short|trade|position)\b|\b(?:set|move|widen|tighten|place|adjust) (?:the |a |your )?(?:stop|target|order|entry)\b/i.test(prose)) throw new Error("Observer explanation included a forecast, trade instruction or unsupported order-flow claim.");
  if (/\b(?:entry|trade|setup|signal) (?:is |looks )?(?:ready|clear|confirmed)\b|\bready (?:to|for) (?:enter|entry|trade)\b/i.test(prose)
    || read.blockers.length && /\bno (?:known )?blockers\b|\ball (?:checks|gates) (?:pass|passed|clear)\b/i.test(prose)) throw new Error("Observer explanation invented entry readiness.");
  if (!Array.isArray(value.factIds) || value.factIds.length < 1 || value.factIds.length > 6
    || value.factIds.some(id => typeof id !== "string" || !read.facts.some(f => f.id === id))
    || new Set(value.factIds).size !== value.factIds.length) throw new Error("Observer explanation contained unsupported evidence.");
  const factIds = value.factIds as string[];
  if (requiredObserverEvidence(read).some(id => !factIds.includes(id))) throw new Error("Observer explanation omitted required context or blockers.");
  const index = value.watchIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= read.changeConditions.length) throw new Error("Observer explanation invented a change condition.");
  return { state: "ready", source: "model", text, at: read.asOf, factIds,
    evidence: factIds.map(id => ({ id, text: read.facts.find(f => f.id === id)!.text })), watch: read.changeConditions[index] };
}

/** Always available, instantaneous, no provider calls and no generated facts. */
export function observerRuleExplanation(read: ObserverRead, state: ObserverRead["ai"]["state"] = "disabled"): ObserverRead["ai"] {
  const direction = read.lean === "up" ? "Closed-candle context leans up." : read.lean === "down" ? "Closed-candle context leans down."
    : read.lean === "conflicting" ? "The hourly and higher timeframe directions disagree." : read.lean === "range" ? "Closed candles show overlapping movement." : "Closed-candle direction is not established.";
  const pressure = read.pressure.direction === "unknown" ? "Short-term quote pressure is not established."
    : read.pressure.relation === "opposed" ? "Short-term quotes are moving against the hourly lean."
    : read.pressure.relation === "aligned" ? "Short-term quotes support the hourly lean."
    : read.pressure.direction === "range" ? "Short-term quotes have no persistent direction." : `Short-term quote pressure leans ${read.pressure.direction}.`;
  const factIds = requiredObserverEvidence(read);
  const text = read.state === "paused" ? `${read.headline}. ${read.blockers[0] ?? "Fresh observations are required."}`
    : `${direction} ${pressure}${read.blockers.length ? ` Entry checks are blocked: ${read.blockers[0]}` : ""}`;
  return { state, source: "rules", text: text.slice(0, 420), at: read.asOf, factIds,
    evidence: factIds.map(id => ({ id, text: read.facts.find(f => f.id === id)!.text })),
    watch: read.changeConditions[read.state === "paused" || read.blockers.length ? 3 : read.pressure.relation === "opposed" ? 2 : 0] ?? read.changeConditions[0] };
}
