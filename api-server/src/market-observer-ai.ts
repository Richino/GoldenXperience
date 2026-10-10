import type { ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { responseText } from "./analyze-explain.js";

/** AI prioritizes supplied evidence. Rendering uses the original facts verbatim. */
export async function explainObserver(read: ObserverRead, fetcher: typeof fetch = fetch): Promise<ObserverRead["ai"]> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { state: "disabled", text: null, at: null, factIds: [] };
  const ids = read.facts.map(f => f.id);
  if (!ids.length) return { state: "disabled", text: null, at: null, factIds: [] };
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ model: process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini", reasoning: { effort: "low" }, max_output_tokens: 1200,
      input: JSON.stringify({ task: "Select up to three supplied fact IDs that best explain this current forex observation. Prefer data/news blockers first, then timeframe disagreement, movement and relevant patterns. A detected shape is not a trade. Do not infer future performance or generate prices. This is evidence prioritization only.", headline: read.headline, facts: read.facts }),
      text: { format: { type: "json_schema", name: "observer_highlights", strict: true, schema: { type: "object", properties: { factIds: { type: "array", items: { type: "string", enum: ids }, minItems: 1, maxItems: 3 } }, required: ["factIds"], additionalProperties: false } } },
    }),
  });
  if (!response.ok) throw new Error(`Observer explanation failed (${response.status}).`);
  const parsed = JSON.parse(responseText(await response.json())) as { factIds?: unknown };
  if (!Array.isArray(parsed.factIds) || parsed.factIds.length < 1 || parsed.factIds.length > 3 || parsed.factIds.some(id => typeof id !== "string" || !ids.includes(id))) throw new Error("Observer explanation contained unsupported evidence.");
  const selected = [...new Set(parsed.factIds)] as string[];
  return { state: "ready", text: selected.map(id => read.facts.find(f => f.id === id)!.text).join(" "), at: read.asOf, factIds: selected };
}

/** Global budget, one in-flight request, per-pair cooldown; no calls from the quote callback. */
export class ObserverAiGate {
  private busy = false;
  private calls: number[] = [];
  private pairs = new Map<string, { revision: number; at: number }>();
  constructor(private readonly explain = explainObserver, private readonly hourlyLimit = 20, private readonly cooldownMs = 90_000) {}
  async request(read: ObserverRead): Promise<ObserverRead["ai"] | null> {
    const now = Date.parse(read.asOf), previous = this.pairs.get(read.instrument);
    if (read.state !== "live" || !read.facts.length || this.busy || previous && now - previous.at < this.cooldownMs) return null;
    if (previous?.revision === read.revision && now - previous.at < 300_000) return null;
    this.calls = this.calls.filter(at => now - at < 3_600_000);
    if (this.calls.length >= this.hourlyLimit) return { state: "limited", text: null, at: null, factIds: [] };
    this.busy = true; this.calls.push(now); this.pairs.set(read.instrument, { revision: read.revision, at: now });
    try { return await this.explain(read); }
    catch { return { state: "error", text: null, at: null, factIds: [] }; }
    finally { this.busy = false; }
  }
}
