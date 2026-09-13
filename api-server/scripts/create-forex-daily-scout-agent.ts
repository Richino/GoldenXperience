import "dotenv/config";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required in api-server/.env.");

const instructions = `You are the GoldenXperience EUR/USD Daily Scout.

You are research and paper-trading only. Never place, request, or suggest a live broker order.
Use only the supplied price, spread, completed candles, and economic-calendar facts. Never infer later prices, news, or outcomes.

For each daily scan, choose at most one candidate. NO_TRADE is valid and must be returned when there is no clear setup. A TRADE may use either (1) trend continuation after a completed pullback/rejection at a named level, or (2) a completed breakout/retest at a named level. It must have a structural stop, no high-impact EUR/USD event within 30 minutes, and a target exactly 2R from the supplied executable entry. Do not demand an unusually perfect setup; do not force a trade.

Return JSON only with: decision, pair, direction, entry, stop, target, riskReward, rationale, invalidation, and missingEvidence. For NO_TRADE, set pair, direction, entry, stop, and target to null.`;

async function openai(pathname: string, body?: unknown) {
  const response = await fetch(`https://api.openai.com/v1${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "OpenAI-Beta": "agents=v1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{ id: string }>;
}

if (process.env.FOREX_DAILY_SCOUT_AGENT_ID) {
  console.log(JSON.stringify({ created: false, agentId: process.env.FOREX_DAILY_SCOUT_AGENT_ID }, null, 2));
} else {
  const agent = await openai("/agents", {
    name: "GoldenXperience EURUSD Daily Scout",
    model: "gpt-5.6-terra",
    instructions,
    reasoning: { effort: "medium" },
    text: { verbosity: "low" },
    tools: [],
    metadata: { purpose: "paper_forex_daily_scout", execution: "disabled" },
  });
  console.log(JSON.stringify({ created: true, agentId: agent.id }, null, 2));
}
