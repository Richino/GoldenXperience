import {
  EXPLANATION_RULES,
  EXPLANATION_SCHEMA,
  validateExplanation,
  type Explanation,
  type ExplanationFacts,
} from "../../frontend/src/lib/strategy/analyze-v2/explain.js";

/**
 * Analyze V2's AI explanation: prose about facts the deterministic engine
 * already calculated. The model cannot change the decision, prices, pips or
 * R: its answer is schema-checked and rejected if it states another decision,
 * uses a number that is not in the facts, or talks about win probability.
 * Any failure returns an error; the app then shows the analysis on its own.
 *
 * Uses the existing OpenAI configuration (OPENAI_API_KEY, OPENAI_ANALYSIS_MODEL).
 */

const TIMEOUT_MS = 20_000;

export function responseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";
  return response.output
    .flatMap((item) => {
      const content = item && typeof item === "object" ? (item as { content?: unknown }).content : null;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        const text = part && typeof part === "object" ? (part as { text?: unknown }).text : null;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("");
}

export async function explainAnalysis(facts: ExplanationFacts): Promise<{ explanation: Explanation; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Explanations are not configured (OPENAI_API_KEY).");
  const model = process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini";
  const prompt = JSON.stringify({
    task: "Explain this forex analysis to the trader who ran it. You are explaining a finished, deterministic result; you are not analysing the market.",
    rules: EXPLANATION_RULES,
    fields: {
      decision: "Copy the decision exactly.",
      summary: "Two or three sentences: what was concluded and the main reason.",
      direction: "Why this direction, from the structure evidence (or why no direction qualified).",
      location: "Why the entry location is relevant (the zone and the trigger), or what is missing there.",
      support: "What supports the continuation thesis: alignment, structure, liquidity context. For no trade: what would have to change.",
      risks: "What could make the trade fail or what blocks it: invalidation, cautions, news, liquidity findings.",
      levels: "Why the stop and target sit where they do (use stopBasis/targetBasis). For no trade: the watch condition, or that there is nothing to watch yet.",
    },
    facts,
  });
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      input: prompt,
      text: { format: { type: "json_schema", name: "analyze_explanation", strict: true, schema: EXPLANATION_SCHEMA } },
    }),
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error(`The explanation model could not respond (${response.status}).`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText(payload));
  } catch {
    throw new Error("The explanation was unreadable.");
  }
  const checked = validateExplanation(parsed, facts);
  if (!checked.ok) throw new Error(`Explanation rejected: ${checked.reason}`);
  return { explanation: checked.explanation, model };
}
