import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

type CalendarEvent = {
  title: string;
  currency: "EUR" | "USD" | string;
  importance: number;
  date: string;
  forecast?: number | null;
  previous?: number | null;
};

type AgentDecision = {
  decision: "TRADE" | "NO_TRADE";
  pair?: string;
  direction?: "LONG" | "SHORT";
  stop?: number;
  target?: number;
  confidence?: number;
  reason?: string;
};

const agentId = process.env.FOREX_DAILY_SCOUT_AGENT_ID ?? process.env.FOREX_PAPER_AGENT_ID;
const apiKey = process.env.OPENAI_API_KEY;
if (!agentId || !apiKey) throw new Error("FOREX_PAPER_AGENT_ID and OPENAI_API_KEY are required in api-server/.env");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calendarPath = path.join(root, "research-v2", "pre-news-prediction-v1", "data", "calendar_raw.json");
const cliArgs = process.argv.slice(2);
const weeksPosition = cliArgs.indexOf("--weeks");
const weeks = weeksPosition >= 0 ? Number(cliArgs[weeksPosition + 1]) : 1;
if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw new Error("--weeks must be an integer from 1 to 12.");
const fromPosition = cliArgs.indexOf("--from");
const toPosition = cliArgs.indexOf("--to");
const from = fromPosition >= 0 ? cliArgs[fromPosition + 1] : undefined;
const to = toPosition >= 0 ? cliArgs[toPosition + 1] : undefined;
const lastFriday = new Date("2026-09-11T16:00:00.000Z");
const firstDay = new Date(lastFriday);
firstDay.setUTCDate(firstDay.getUTCDate() - (weeks * 7 - 1));
const allDecisionTimes: string[] = [];
for (const day = new Date(firstDay); day <= lastFriday; day.setUTCDate(day.getUTCDate() + 1)) {
  if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) allDecisionTimes.push(day.toISOString());
}
const optionValueIndexes = new Set([weeksPosition + 1, fromPosition + 1, toPosition + 1]);
const requestedTimes = new Set(cliArgs.filter((value, index) => value !== "--weeks" && value !== "--from" && value !== "--to" && !optionValueIndexes.has(index)));
const rangedTimes = allDecisionTimes.filter((time) => (!from || time >= from) && (!to || time <= to));
const decisionTimes = requestedTimes.size === 0 ? rangedTimes : rangedTimes.filter((time) => requestedTimes.has(time));
if (decisionTimes.length === 0) throw new Error("Pass an exact supported decision timestamp or no argument for the full week.");

async function openAi(pathname: string, init: RequestInit = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`https://api.openai.com/v1${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "OpenAI-Beta": "agents=v1", ...(init.headers ?? {}) },
    });
    if (response.ok) return response.json() as Promise<any>;
    const body = await response.text();
    if (response.status < 500 && response.status !== 429) throw new Error(`OpenAI ${response.status}: ${body}`);
    if (attempt === 2) throw new Error(`OpenAI ${response.status}: ${body}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error("OpenAI retry loop exhausted.");
}

function formatCandles(candles: ResearchCandle[]) {
  return candles.map((c) => `${c.time.slice(0, 16)}Z O:${c.mid.open.toFixed(5)} H:${c.mid.high.toFixed(5)} L:${c.mid.low.toFixed(5)} C:${c.mid.close.toFixed(5)}`).join("\n");
}

function parseDecision(text: string): AgentDecision {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const candidate = fenced.match(/\{[\s\S]*\}/)?.[0] ?? fenced;
  const parsed = JSON.parse(candidate) as AgentDecision;
  if (parsed.decision !== "TRADE" && parsed.decision !== "NO_TRADE") throw new Error("Agent did not return a valid decision");
  return parsed;
}

function evaluate(decision: AgentDecision, entry: number, candles: ResearchCandle[]) {
  if (decision.decision !== "TRADE" || !decision.direction || !Number.isFinite(decision.stop) || !Number.isFinite(decision.target)) {
    return { outcome: "NO_TRADE" as const, r: 0, detail: decision.reason ?? "Agent declined" };
  }
  const stop = Number(decision.stop);
  const target = Number(decision.target);
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const direction = decision.direction;
  const valid = risk > 0 && Math.abs(reward / risk - 2) < 0.02 &&
    (direction === "LONG" ? stop < entry && target > entry : stop > entry && target < entry);
  if (!valid) return { outcome: "INVALID" as const, r: 0, detail: "Rejected: levels were not a valid 1:2 setup at the supplied executable entry." };

  for (const candle of candles) {
    const stopHit = direction === "LONG" ? candle.bid.low <= stop : candle.ask.high >= stop;
    const targetHit = direction === "LONG" ? candle.bid.high >= target : candle.ask.low <= target;
    // A single M15 bar cannot establish which level came first. Score the ambiguous case as a loss.
    if (stopHit && targetHit) return { outcome: "LOSS" as const, r: -1, detail: `Ambiguous M15 bar scored conservatively at ${candle.time}` };
    if (stopHit) return { outcome: "LOSS" as const, r: -1, detail: `Stop hit at ${candle.time}` };
    if (targetHit) return { outcome: "WIN" as const, r: 2, detail: `Target hit at ${candle.time}` };
  }
  return { outcome: "OPEN_AT_CUTOFF" as const, r: 0, detail: "Neither level hit before the daily cutoff." };
}

async function run() {
  const calendar = JSON.parse(await readFile(calendarPath, "utf8")) as CalendarEvent[];
  const rows: unknown[] = [];

  for (const at of decisionTimes) {
    console.log(`Preparing snapshot for ${at}`);
    // This read happens before the model is called; it only requests completed candles ending at the decision time.
    const history = (await getResearchCandles("EUR_USD", "H1", 72, { to: at })).filter((c) => c.complete && c.time <= at);
    const latest = history.at(-1);
    if (!latest) throw new Error(`No EUR_USD H1 candle found before ${at}`);
    const bid = latest.bid.close;
    const ask = latest.ask.close;
    const news = calendar
      .filter((e) => (e.currency === "EUR" || e.currency === "USD") && e.importance >= 1 && e.date >= at && e.date <= new Date(new Date(at).getTime() + 24 * 60 * 60 * 1000).toISOString())
      .map((e) => ({ time: e.date, currency: e.currency, event: e.title, forecast: e.forecast ?? null, previous: e.previous ?? null }));

    const prompt = `Historical paper decision only. Timestamp: ${at}. Pair: EUR/USD.\n\nYou may use ONLY this supplied snapshot. Do not infer later prices or news.\nExecutable entry now: LONG uses ask ${ask.toFixed(5)}; SHORT uses bid ${bid.toFixed(5)}.\nUpcoming high-impact EUR/USD calendar in the next 24h (actual values deliberately omitted): ${JSON.stringify(news)}\n\nLast 72 completed H1 midpoint candles:\n${formatCandles(history)}\n\nReturn JSON only. Choose NO_TRADE unless there is a clear setup. If TRADE, pair must be EUR_USD, direction LONG or SHORT, stop and target must be finite prices, and target must be exactly 2R from the executable entry above. Do not invent an entry price.`;
    console.log(`Requesting paper decision for ${at}`);
    const session = await openAi("/agents/sessions", { method: "POST", body: JSON.stringify({ agent_id: agentId, input: prompt, environment: { type: "none" } }) });
    let state = session;
    for (let i = 0; i < 120 && state.status !== "idle"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await openAi(`/agents/sessions/${session.id}`);
    }
    if (state.status !== "idle") throw new Error(`Agent session ${session.id} did not finish: ${state.status}`);
    const items = await openAi(`/agents/sessions/${session.id}/items`);
    const assistant = items.data?.find((item: any) => item.role === "assistant");
    const answer = assistant?.content?.map((part: any) => part.text ?? part.output_text ?? "").join("\n") ?? "";
    const decision = parseDecision(answer);

    // Outcome data is intentionally fetched only after the agent decision is complete.
    const cutoff = new Date(new Date(at).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const outcomeCandles = (await getResearchCandles("EUR_USD", "M15", 160, { to: cutoff }))
      .filter((c) => c.complete && c.time > at && c.time <= cutoff);
    const entry = decision.direction === "SHORT" ? bid : ask;
    const result = evaluate(decision, entry, outcomeCandles);
    console.log(`Scored ${at}: ${result.outcome}`);
    const row = { at, entry: Number(entry.toFixed(5)), decision, result, agentSessionId: session.id };
    console.log(JSON.stringify(row));
    rows.push(row);
  }

  console.log(JSON.stringify({
    scope: `EUR/USD, ${allDecisionTimes[0]?.slice(0, 10)} through ${allDecisionTimes.at(-1)?.slice(0, 10)}, one paper decision per weekday at 16:00 UTC, 24-hour maximum hold`,
    method: "Agent saw only prior H1 candles and pre-event calendar fields. Results use OANDA M15 executable bid/ask candles; same-bar stop/target conflicts count as losses.",
    results: rows,
  }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
