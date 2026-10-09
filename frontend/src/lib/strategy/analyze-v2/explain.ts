import { precisionFor } from "@/lib/instruments/catalog";
import type { AnalysisResult } from "@/lib/strategy/analyze-v2/decide";

/**
 * The AI explanation layer's contract. The model receives only these
 * calculated facts and writes prose about them; it decides nothing and
 * computes nothing. Its answer is rejected (and the deterministic analysis
 * shown alone) when it:
 *   - does not match the schema or the length limits,
 *   - states a different decision than the engine's,
 *   - contains a number that does not appear in the facts,
 *   - talks about win probability or chances of success.
 * Shared by the api-server (which calls the model) and the app.
 */

export interface ExplanationFacts {
  pair: string;
  mode: "NORMAL" | "SWING";
  decision: "LONG" | "SHORT" | "NO_TRADE";
  headline: string;
  timeframes: { structure: string; higher: string };
  structure: { primaryTrend: string; higherTrend: string | null; alignment: string; evidence: string[]; structureLevel: string | null };
  setup: { status: string; zone: string | null; retracedShareOfImpulse: string | null };
  plan: {
    entry: string; stop: string; target: string; stopPips: string; targetPips: string; rewardRisk: string; spreadPips: string;
    stopBasis: string; targetBasis: string;
  } | null;
  checks: Array<{ check: string; status: string; reason: string }>;
  news: { state: string; reason: string };
  volatility: string;
  liquidity: { risk: string; findings: string[]; confirmation: string | null; nearestAbove: string | null; nearestBelow: string | null };
  invalidation: string;
  watch: string | null;
}

export interface Explanation {
  /** Echo of the engine's decision; must match. */
  decision: "LONG" | "SHORT" | "NO_TRADE";
  /** Two or three sentences: what the analysis concluded and why. */
  summary: string;
  /** Why this direction (or why no direction qualified). */
  direction: string;
  /** Why the entry location matters, or what is missing at it. */
  location: string;
  /** What supports the continuation thesis (or what would have to change). */
  support: string;
  /** What could make the trade fail, or the risks that block it. */
  risks: string;
  /** Why the stop and target sit where they do; for no trade, what to watch. */
  levels: string;
}

export const EXPLANATION_FIELDS = ["summary", "direction", "location", "support", "risks", "levels"] as const;
const MAX_FIELD = { summary: 420, direction: 360, location: 360, support: 360, risks: 420, levels: 420 } as const;

/** JSON schema for the model's structured output (strict). */
export const EXPLANATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", ...EXPLANATION_FIELDS],
  properties: {
    decision: { type: "string", enum: ["LONG", "SHORT", "NO_TRADE"] },
    ...Object.fromEntries(EXPLANATION_FIELDS.map((field) => [field, { type: "string", minLength: 1, maxLength: MAX_FIELD[field] }])),
  },
} as const;

export const EXPLANATION_RULES = [
  "Explain only the supplied facts. Do not add market data, news, levels or reasons that are not in them.",
  "Never calculate, round, convert or alter a number. Copy prices, pips and ratios exactly as written in the facts, or leave them out.",
  "The decision is final. Do not suggest a different direction, an earlier entry, a wider stop or a different target.",
  "Never state or imply a probability or chance of winning. No hype words (strong, explosive, guaranteed, sure).",
  "Describe liquidity sweeps as price-action context, never as proof of institutional stop orders or manipulation.",
  "For NO_TRADE: say exactly which checks failed and what would have to change; use 'levels' for what to watch, if a watch condition is given.",
  "Plain English for a trader, short sentences, no headings or bullet characters.",
  "The screen already shows the decision: do not open any field with it (no \"LONG.\", \"NO_TRADE.\"); start with the reason.",
];

export function explanationFacts(result: AnalysisResult): ExplanationFacts {
  const digits = precisionFor(result.pair);
  const price = (value: number | null | undefined) => (typeof value === "number" ? value.toFixed(digits) : null);
  const plan = result.execution;
  const liquidity = result.liquidity.assessment;
  const near = (item: typeof liquidity.nearestAbove) =>
    item ? `${item.level.labels.join(" / ")} ${item.level.price.toFixed(digits)} (${item.level.status.toLowerCase().replace(/_/g, " ")}, ${item.distancePips.toFixed(1)} pips)` : null;
  return {
    pair: result.pair.replace("_", "/"),
    mode: result.mode,
    decision: result.decision,
    headline: result.headline,
    timeframes: { structure: result.marketStructure.primaryTimeframe, higher: result.marketStructure.higherTimeframe },
    structure: {
      primaryTrend: result.marketStructure.primaryTrend,
      higherTrend: result.marketStructure.higherTimeframeTrend,
      alignment: result.marketStructure.alignmentText,
      evidence: result.marketStructure.evidence,
      structureLevel: price(result.marketStructure.structureLevel),
    },
    setup: {
      status: result.setup.status,
      zone: result.setup.zoneLow !== null && result.setup.zoneHigh !== null ? `${price(result.setup.zoneLow)}–${price(result.setup.zoneHigh)}` : null,
      retracedShareOfImpulse: result.setup.depth === null ? null : `${Math.round(result.setup.depth * 100)}%`,
    },
    plan: plan
      ? {
          entry: price(plan.entry)!,
          stop: price(plan.stop)!,
          target: price(plan.target)!,
          stopPips: plan.stopPips.toFixed(1),
          targetPips: plan.targetPips.toFixed(1),
          rewardRisk: plan.rewardRisk.toFixed(2),
          spreadPips: plan.spreadPips.toFixed(1),
          stopBasis: plan.stopBasis,
          targetBasis: plan.targetBasis,
        }
      : null,
    checks: result.checks.filter((check) => check.evaluated).map((check) => ({ check: check.label, status: check.status, reason: check.reason })),
    news: { state: result.news.state, reason: result.news.reason },
    volatility: result.volatility.reason,
    liquidity: {
      risk: liquidity.risk,
      findings: liquidity.findings,
      confirmation: liquidity.confirmation,
      nearestAbove: near(liquidity.nearestAbove),
      nearestBelow: near(liquidity.nearestBelow),
    },
    invalidation: result.invalidation,
    watch: result.watch?.condition ?? null,
  };
}

/**
 * Every number in a text, read whole ("1.81R" is 1.81, "6h" is 6). Digits
 * that follow a letter are names, not numbers (M15, H1, D1).
 */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9.])\d+(?:\.\d+)?/g)].map((match) => match[0]);
}

/** Canonical numeric form, so "15" matches "15.0" and "1.10900" matches "1.109". */
const canonical = (token: string) => String(Number(token));

export type ExplanationCheck = { ok: true; explanation: Explanation } | { ok: false; reason: string };

/** Runtime validation of the model's answer against the facts it was given. */
export function validateExplanation(raw: unknown, facts: ExplanationFacts): ExplanationCheck {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "The explanation was not an object." };
  const value = raw as Record<string, unknown>;
  if (value.decision !== facts.decision) return { ok: false, reason: `The explanation stated ${String(value.decision)}, not ${facts.decision}.` };
  const explanation = { decision: facts.decision } as Explanation;
  for (const field of EXPLANATION_FIELDS) {
    const text = value[field];
    if (typeof text !== "string" || !text.trim()) return { ok: false, reason: `The explanation is missing "${field}".` };
    if (text.length > MAX_FIELD[field]) return { ok: false, reason: `"${field}" is too long.` };
    explanation[field] = text.trim();
  }
  const allowed = new Set(numbersIn(JSON.stringify(facts)).map(canonical));
  const all = EXPLANATION_FIELDS.map((field) => explanation[field]).join(" ");
  const invented = numbersIn(all).filter((token) => !allowed.has(canonical(token)));
  if (invented.length) return { ok: false, reason: `The explanation used numbers that are not in the analysis: ${[...new Set(invented)].slice(0, 5).join(", ")}.` };
  if (/\b(probability|odds|chance of (winning|success|profit)|likely to (win|succeed)|\d+\s?% (chance|likely|probability))\b/i.test(all)) {
    return { ok: false, reason: "The explanation talked about win probability." };
  }
  return { ok: true, explanation };
}

/** Shape check for facts arriving at the server (size-capped; it never trusts types). */
export function parseExplanationFacts(value: unknown): ExplanationFacts | null {
  if (!value || typeof value !== "object") return null;
  const facts = value as Partial<ExplanationFacts>;
  if (JSON.stringify(facts).length > 16_000) return null;
  if (facts.decision !== "LONG" && facts.decision !== "SHORT" && facts.decision !== "NO_TRADE") return null;
  if (facts.mode !== "NORMAL" && facts.mode !== "SWING") return null;
  if (typeof facts.pair !== "string" || typeof facts.headline !== "string" || !Array.isArray(facts.checks)) return null;
  if ((facts.decision === "NO_TRADE") !== (facts.plan === null)) return null;
  return facts as ExplanationFacts;
}
