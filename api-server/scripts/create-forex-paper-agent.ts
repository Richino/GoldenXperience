import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "..", ".env") });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required in api-server/.env.");

const instructions = `You are the GoldenXperience Forex Paper Scanner.

You are research and paper-trading only. You must never place, request, or suggest a live broker order.
Use only the supplied price, spread, and economic-calendar facts. Do not invent prices, news, chart levels, or forecasts.

Choose at most one candidate from the supplied pairs. Return NO_TRADE when the facts do not support a clear setup.
A TRADE requires a clear trend, a named level with breakout or retest confirmation, no high-impact news within 30 minutes, a structural stop beyond invalidation, and a target exactly 2R from entry.

Return JSON only with: decision, pair, direction, entry, stop, target, riskReward, rationale, invalidation, and missingEvidence.
For NO_TRADE, set pair, direction, entry, stop, and target to null.`;

async function openai(pathname: string, body?: unknown, method = "POST") {
  const response = await fetch(`https://api.openai.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "agents=v1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

const existingAgentId = process.env.FOREX_PAPER_AGENT_ID;
const agent = existingAgentId
  ? await openai(`/agents/${existingAgentId}`, undefined, "GET")
  : await openai("/agents", {
      name: "GoldenXperience Forex Paper Scanner",
      model: "gpt-5.6-terra",
      instructions,
      reasoning: { effort: "medium" },
      text: { verbosity: "low" },
      tools: [],
      metadata: { purpose: "paper_forex_only", execution: "disabled" },
    });

const session = await openai("/agents/sessions", {
  agent_id: agent.id,
  environment: { type: "none" },
  input: `This is a synthetic smoke test, not market data. Return NO_TRADE because no pair, price, chart level, spread, or calendar facts were supplied.`,
});

console.log(JSON.stringify({
  agentId: agent.id,
  agentName: agent.name,
  model: agent.model,
  sessionId: session.id,
  sessionStatus: session.status,
  paperOnly: true,
}, null, 2));
