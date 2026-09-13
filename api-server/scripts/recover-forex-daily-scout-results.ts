import "dotenv/config";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

type Decision = { decision: "TRADE" | "NO_TRADE"; direction?: "LONG" | "SHORT"; stop?: number; target?: number };
type Session = { id: string };

const apiKey = process.env.OPENAI_API_KEY;
const agentId = process.env.FOREX_DAILY_SCOUT_AGENT_ID;
if (!apiKey || !agentId) throw new Error("OPENAI_API_KEY and FOREX_DAILY_SCOUT_AGENT_ID are required.");

async function api(pathname: string) {
  const response = await fetch(`https://api.openai.com/v1${pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "agents=v1" },
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
}

function parseJson(text: string): Decision {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("Agent response had no JSON");
  return JSON.parse(json) as Decision;
}

function score(direction: "LONG" | "SHORT", entry: number, stop: number, target: number, candles: ResearchCandle[], rewardR = 2) {
  let bestFavorable = entry;
  for (const candle of candles) {
    bestFavorable = direction === "LONG" ? Math.max(bestFavorable, candle.bid.high) : Math.min(bestFavorable, candle.ask.low);
    const stopHit = direction === "LONG" ? candle.bid.low <= stop : candle.ask.high >= stop;
    const targetHit = direction === "LONG" ? candle.bid.high >= target : candle.ask.low <= target;
    if (stopHit && targetHit) return { outcome: "LOSS", r: -1, exit: stop, exitTime: candle.time, bestFavorable, detail: "Same M15 bar: conservative stop-first score" };
    if (stopHit) return { outcome: "LOSS", r: -1, exit: stop, exitTime: candle.time, bestFavorable, detail: "Stop hit" };
    if (targetHit) return { outcome: "WIN", r: rewardR, exit: target, exitTime: candle.time, bestFavorable, detail: "Target hit" };
  }
  return { outcome: "OPEN_AT_24H_CUTOFF", r: null, exit: null, exitTime: null, bestFavorable, detail: "Neither level hit" };
}

const start = "2026-08-13T16:00:00.000Z";
const end = "2026-09-11T16:00:00.000Z";
const riskRewardPosition = process.argv.indexOf("--rr");
const riskReward = riskRewardPosition >= 0 ? Number(process.argv[riskRewardPosition + 1]) : 2;
const originallyClosedOnly = process.argv.includes("--originally-closed-only");
const reverse = process.argv.includes("--reverse");
if (!Number.isFinite(riskReward) || riskReward <= 0) throw new Error("--rr must be a positive number.");
const sessions = (await api(`/agents/sessions?agent_id=${encodeURIComponent(agentId)}&limit=100`)).data as Session[];
const recovered = await Promise.all(sessions.map(async (session) => {
  const items = (await api(`/agents/sessions/${session.id}/items`)).data as any[];
  const userText = items.find((item) => item.role === "user")?.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
  const at = userText.match(/Timestamp: ([0-9T:.Z-]+)/)?.[1]?.replace(/[.,]$/, "");
  if (!at || at < start || at > end) return null;
  const assistantText = items.find((item) => item.role === "assistant")?.content?.map((part: any) => part.text ?? part.output_text ?? "").join("\n") ?? "";
  const decision = parseJson(assistantText);
  if (decision.decision !== "TRADE" || !decision.direction || !Number.isFinite(decision.stop) || !Number.isFinite(decision.target)) return null;
  const prices = userText.match(/LONG uses ask ([0-9.]+); SHORT uses bid ([0-9.]+)/);
  if (!prices) throw new Error(`No executable entry prices in ${session.id}`);
  const originalDirection = decision.direction;
  const originalEntry = originalDirection === "LONG" ? parseFloat(prices[1]) : parseFloat(prices[2]);
  const originalStop = Number(decision.stop);
  const originalTarget = Number(decision.target);
  const direction = reverse ? (originalDirection === "LONG" ? "SHORT" : "LONG") : originalDirection;
  const entry = direction === "LONG" ? parseFloat(prices[1]) : parseFloat(prices[2]);
  const stopDistance = Math.abs(originalEntry - originalStop);
  const stop = direction === "LONG" ? entry - stopDistance : entry + stopDistance;
  const target = direction === "LONG"
    ? entry + Math.abs(entry - stop) * riskReward
    : entry - Math.abs(entry - stop) * riskReward;
  const cutoff = new Date(new Date(at).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const candles = (await getResearchCandles("EUR_USD", "M15", 160, { to: cutoff })).filter((c) => c.complete && c.time > at && c.time <= cutoff);
  const originalResult = score(originalDirection, originalEntry, originalStop, originalTarget, candles, 2);
  if (originallyClosedOnly && originalResult.outcome === "OPEN_AT_24H_CUTOFF") return null;
  return { date: at.slice(0, 10), direction, entry, stop, target, riskReward, ...score(direction, entry, stop, target, candles, riskReward) };
}));

console.table(recovered.filter(Boolean));
