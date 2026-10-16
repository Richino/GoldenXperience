import { REPORT_SCHEMA, validateReport, type IntelligenceReport } from "./research-report.js";
import type { CalendarSnapshot } from "./calendar-snapshot.js";

/**
 * One research run: the OpenAI Responses API with web search, answering in
 * the strict report schema. The model gets the verified calendar slice and
 * the deterministic technical read; it is told to cite only pages its search
 * returned, and the validator enforces that. It never sets prices, levels,
 * or anything about orders.
 *
 * Configuration (no model id is hardcoded beyond the app's existing default):
 *   OPENAI_RESEARCH_MODEL        model for research (falls back to OPENAI_ANALYSIS_MODEL, then gpt-5-mini)
 *   OPENAI_RESEARCH_EFFORT       reasoning effort (default low)
 *   OPENAI_WEB_SEARCH_TOOL       tool type (default "web_search")
 *   OPENAI_PRICE_INPUT_PER_MTOK / OPENAI_PRICE_OUTPUT_PER_MTOK / OPENAI_PRICE_WEB_SEARCH_CALL
 *                                USD prices for the cost estimate; unset means "cost unknown"
 */

export type TechnicalSummary = {
  instrument: string;
  readAt: string;
  price: number | null;
  trend: Record<string, string | null>;
  atr: Record<string, number>;
  zones: Array<{ low: number; high: number; type: string; relevance: string }>;
  plans: Array<{ direction: string; setup: string; zone: [number, number]; stop: number | null; target: number | null }>;
};

export type ResearchUsage = { inputTokens: number | null; outputTokens: number | null; webSearchCalls: number; costUsd: number | null };

export type ResearchOutcome =
  | { ok: true; model: string; report: IntelligenceReport; sources: Array<{ url: string; title: string | null }>; dropped: unknown[]; usage: ResearchUsage }
  | { ok: false; model: string; error: string; usage: ResearchUsage; sources: Array<{ url: string; title: string | null }> };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 150_000;

export function researchConfig(env: NodeJS.ProcessEnv = process.env) {
  const price = (name: string) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= 0 && env[name]?.trim() ? value : null;
  };
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    model: env.OPENAI_RESEARCH_MODEL?.trim() || env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini",
    effort: env.OPENAI_RESEARCH_EFFORT?.trim() || "low",
    webSearchTool: env.OPENAI_WEB_SEARCH_TOOL?.trim() || "web_search",
    prices: { inputPerMTok: price("OPENAI_PRICE_INPUT_PER_MTOK"), outputPerMTok: price("OPENAI_PRICE_OUTPUT_PER_MTOK"), perSearch: price("OPENAI_PRICE_WEB_SEARCH_CALL") },
  };
}

export function estimateCost(usage: Omit<ResearchUsage, "costUsd">, prices: ReturnType<typeof researchConfig>["prices"]): number | null {
  if (prices.inputPerMTok === null || prices.outputPerMTok === null || prices.perSearch === null) return null;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const cost = (usage.inputTokens / 1e6) * prices.inputPerMTok + (usage.outputTokens / 1e6) * prices.outputPerMTok + usage.webSearchCalls * prices.perSearch;
  return Number(cost.toFixed(6));
}

const RULES = [
  "You are researching the market context for a forex pair for a trader. You do NOT predict price and you do NOT decide trades.",
  "Use web search. Prefer, in order: official central bank and statistics releases, Reuters/AP/Bloomberg-class reporting, established financial publications, established forex analysis sites.",
  "Cover, where relevant to these two currencies: central bank policy and recent speeches, rate-decision expectations, inflation, employment, growth and retail data, government bond yields, the US dollar index, risk-on/risk-off conditions, geopolitical or fiscal developments. Skip what is not relevant to this pair.",
  "News: last 7 days unless it is the latest policy decision. Every news item, evidence point and sentiment observation MUST cite URLs your web search returned in this session. Never cite a page you did not retrieve; never invent headlines, quotes, dates or figures.",
  "Mark each news item FACT (reported event or data) or ANALYSIS (someone's interpretation or forecast). Several outlets repeating one claim are ONE item.",
  "Economic releases: use the verified calendar given below for times, forecasts and actuals. Do not restate numbers from memory. A release above forecast does not by itself mean its currency rises; judge by the reported market reaction and expectations, and say so when unclear.",
  "Community sentiment (e.g. public Forex Factory threads, trader commentary): only from public pages your search returned. Label each observation POSITIONING (reported positioning data), BULLISH_CALL / BEARISH_CALL (explicit prediction), NEUTRAL or SPECULATION. A few comments are not 'the market'. If you found none, say so in limitations.",
  "Prices, levels, trends and the BUY/SELL plans come only from the technical summary given below. Do not invent prices or indicator values. You may relate the evidence to those plans.",
  "Build BOTH a bullish case (evidence that would support the BUY plan) and a bearish case (supporting the SELL plan), each point cited. It is fine for both to be weak.",
  "overallBias: BULLISH / BEARISH / MIXED / UNCLEAR for the pair (base vs quote). confidence: LOW / MEDIUM / HIGH, qualitative. If evidence conflicts or is thin, say MIXED or UNCLEAR with LOW confidence.",
  "technicalVsFundamental: where the technical read and the fundamental evidence agree or conflict.",
  "conclusion: what the evidence currently supports, what would invalidate it, and what must still be confirmed by price.",
  "Be concise: short sentences, no full articles.",
];

/** Every URL the search returned this run: web_search_call sources and message citations. */
export function collectSources(payload: unknown): Array<{ url: string; title: string | null }> {
  const out = new Map<string, { url: string; title: string | null }>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url) && !out.has(url)) out.set(url, { url, title: typeof title === "string" ? title : null });
  };
  for (const item of ((payload as { output?: unknown[] })?.output ?? []) as Array<Record<string, unknown>>) {
    if (item.type === "web_search_call") {
      const action = item.action as { sources?: Array<{ url?: unknown; title?: unknown }> } | undefined;
      for (const source of action?.sources ?? []) add(source.url, source.title);
    }
    if (item.type === "message") {
      for (const part of (item.content ?? []) as Array<{ annotations?: Array<{ type?: string; url?: unknown; title?: unknown }> }>) {
        for (const annotation of part.annotations ?? []) if (annotation.type === "url_citation") add(annotation.url, annotation.title);
      }
    }
  }
  return [...out.values()];
}

export function outputText(payload: unknown): string {
  const direct = (payload as { output_text?: unknown })?.output_text;
  if (typeof direct === "string") return direct;
  return (((payload as { output?: unknown[] })?.output ?? []) as Array<Record<string, unknown>>)
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content ?? []) as Array<{ text?: unknown }>)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

export async function runResearch(input: {
  instrument: string;
  currencies: [string, string];
  technical: TechnicalSummary;
  calendar: CalendarSnapshot;
  now: number;
  fetcher?: Fetcher;
  env?: NodeJS.ProcessEnv;
}): Promise<ResearchOutcome> {
  const config = researchConfig(input.env);
  const fetcher = input.fetcher ?? fetch;
  const empty: ResearchUsage = { inputTokens: null, outputTokens: null, webSearchCalls: 0, costUsd: null };
  if (!config.apiKey) return { ok: false, model: config.model, error: "Research is not configured (OPENAI_API_KEY).", usage: empty, sources: [] };

  const [base, quote] = input.currencies;
  const prompt = JSON.stringify({
    task: `Market intelligence for ${base}/${quote} as of ${new Date(input.now).toISOString()} (UTC).`,
    rules: RULES,
    verifiedCalendar: input.calendar,
    technicalSummary: input.technical,
  });

  let response: Response;
  try {
    response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: config.model,
        reasoning: { effort: config.effort },
        tools: [{ type: config.webSearchTool }],
        include: ["web_search_call.action.sources"],
        input: prompt,
        store: false,
        text: { format: { type: "json_schema", name: "market_intelligence", strict: true, schema: REPORT_SCHEMA } },
      }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, model: config.model, error: timedOut ? "The research request timed out." : "OpenAI could not be reached.", usage: empty, sources: [] };
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const usageRaw = (payload?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const webSearchCalls = ((payload?.output ?? []) as Array<{ type?: string }>).filter((item) => item.type === "web_search_call").length;
  const usageBase = {
    inputTokens: typeof usageRaw.input_tokens === "number" ? usageRaw.input_tokens : null,
    outputTokens: typeof usageRaw.output_tokens === "number" ? usageRaw.output_tokens : null,
    webSearchCalls,
  };
  const usage: ResearchUsage = { ...usageBase, costUsd: estimateCost(usageBase, config.prices) };
  if (!response.ok) {
    const message = (payload?.error as { message?: string } | undefined)?.message;
    const reason = response.status === 429 ? "OpenAI rate limit or quota reached." : `OpenAI returned ${response.status}${message ? `: ${message.slice(0, 200)}` : ""}.`;
    return { ok: false, model: config.model, error: reason, usage, sources: [] };
  }
  const sources = collectSources(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText(payload));
  } catch {
    return { ok: false, model: config.model, error: "The research answer was not valid JSON.", usage, sources };
  }
  const checked = validateReport(parsed, sources.map((source) => source.url), [base, quote]);
  if (!checked.ok) return { ok: false, model: config.model, error: `Research rejected: ${checked.reason}`, usage, sources };
  return { ok: true, model: config.model, report: checked.report, sources, dropped: checked.dropped, usage };
}
