import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";

/**
 * Research-only replay. It does not import or alter production manual-analysis.ts.
 * Prompt/schema/data transforms intentionally mirror recovered blob c014f587.
 * Per user authorization, historical calendar context is omitted as [] because the
 * Sep 14 ForexFactory week payload was not retained.
 */
type Direction = "long" | "short";
type Decision = { direction: Direction; confidence: number; riskPips: number; preferredEntryTime: string; rationale: string };
type Row = {
  decisionTime: string; candleStart: string; pair: "EUR_USD"; direction: Direction; confidence: number;
  referenceMid: number; entry: number; riskPips: number;
  endpointPips: Record<"15m" | "30m" | "1h" | "2h" | "4h", number | null>;
  correct: Record<"15m" | "30m" | "1h" | "2h" | "4h", boolean | null>;
  mfePips: Record<"30m" | "1h" | "2h" | "4h", number | null>;
  maePips: Record<"30m" | "1h" | "2h" | "4h", number | null>;
  rationale: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "..", "frontend", "research-output");
const arg = process.argv.includes("--hourly") ? "hourly" : "sep14";
const shardCount = Math.max(1, Number.parseInt(process.env.SEP14_REPLAY_SHARD_COUNT ?? "1", 10) || 1);
const shardIndex = Math.max(0, Number.parseInt(process.env.SEP14_REPLAY_SHARD_INDEX ?? "0", 10) || 0);
if (shardIndex >= shardCount) throw new Error("SEP14_REPLAY_SHARD_INDEX must be lower than SEP14_REPLAY_SHARD_COUNT.");
const start = arg === "sep14" ? "2026-09-14T00:00:00.000Z" : "2026-06-01T00:00:00.000Z";
const end = arg === "sep14" ? "2026-09-15T00:00:00.000Z" : "2026-09-19T00:00:00.000Z";
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("OPENAI_API_KEY is required for replay.");
const horizons = { "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240 } as const;
const excursionHorizons = { "30m": 30, "1h": 60, "2h": 120, "4h": 240 } as const;
const pip = 0.0001;

function completedAt(c: ResearchCandle, cutoff: number) {
  return c.complete && Date.parse(c.time) + 15 * 60_000 <= cutoff;
}

function promptCandles(candles: ResearchCandle[]) {
  return candles.slice(-32).map((c) => ({ t: c.time, o: c.mid.open, h: c.mid.high, l: c.mid.low, c: c.mid.close }));
}

function responseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";
  return response.output.flatMap((item) => {
    const content = item && typeof item === "object" ? (item as { content?: unknown }).content : undefined;
    return Array.isArray(content) ? content.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []) : [];
  }).join("\n");
}

function asDecision(value: unknown): Decision {
  const d = value as Partial<Decision>;
  const confidence = typeof d.confidence === "number" ? d.confidence : Number(d.confidence);
  const riskPips = typeof d.riskPips === "number" ? d.riskPips : Number(d.riskPips);
  if ((d.direction !== "long" && d.direction !== "short") || !Number.isInteger(confidence) || confidence < 1 || confidence > 100 || !Number.isFinite(riskPips) || riskPips < 8 || riskPips > 40 || typeof d.preferredEntryTime !== "string" || d.preferredEntryTime.trim().length < 6 || typeof d.rationale !== "string" || d.rationale.trim().length < 12) throw new Error("Model returned invalid frozen-schema decision.");
  return { direction: d.direction, confidence, riskPips, preferredEntryTime: d.preferredEntryTime.trim().slice(0, 140), rationale: d.rationale.trim().slice(0, 260) };
}

async function ask(decisionTime: string, m15: ResearchCandle[], h1: ResearchCandle[]): Promise<Decision> {
  const last = m15.at(-1)!;
  const quote = { bid: last.bid.close, ask: last.ask.close, mid: last.mid.close, time: decisionTime };
  const market = getForexSessionStatus(new Date(decisionTime));
  // This object is the recovered prompt with the user-authorized calendar omission only.
  const prompt = JSON.stringify({
    task: "Produce one forced, test-only manual forex trade proposal. This is not an order and must never be described as certain or guaranteed.",
    instrument: "EUR_USD",
    executablePrice: quote,
    marketCondition: { marketOpen: market.marketOpen, session: market.label, checkedAt: decisionTime },
    spreadPips: (quote.ask - quote.bid) / pip,
    candles: { m15: promptCandles(m15), h1: promptCandles(h1) },
    upcomingRelevantCalendar: [],
    requiredOutput: {
      direction: "long or short", confidence: "integer 1 through 100; calibration, not probability of profit", riskPips: "number from 8 through 40",
      preferredEntryTime: "short, specific timing guidance in ET, such as 'Enter now only after a 15m close below 110.68' or 'Wait for the 8:30–10:30 AM ET window'",
      rationale: "two short sentences in plain beginner English explaining why BUY or SELL is suggested and what could make it wrong",
    },
    rules: [
      "You must choose exactly one direction because this screen is a forced-proposal test.",
      "Use only the supplied data. Do not browse, invent news, or promise a result.",
      "The application will calculate executable entry, stop, and exactly 2R target from your direction and riskPips.",
      "If marketOpen is false, do not say enter now. State that the market is closed and tell the user to reassess after it reopens.",
      "Write the rationale for a beginner. Avoid jargon such as lower highs, momentum, support, resistance, breakout, or liquidity. Say plainly whether buyers or sellers are in control and name the price that would make the idea wrong.",
    ],
  });
  for (let i = 0; i < 3; i++) {
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5-mini", reasoning: { effort: "low" }, input: prompt, text: { format: { type: "json_schema", name: "manual_forex_proposal", strict: true, schema: { type: "object", additionalProperties: false, required: ["direction", "confidence", "riskPips", "preferredEntryTime", "rationale"], properties: { direction: { type: "string", enum: ["long", "short"] }, confidence: { type: "integer", minimum: 1, maximum: 100 }, riskPips: { type: "number", minimum: 8, maximum: 40 }, preferredEntryTime: { type: "string", minLength: 6, maxLength: 140 }, rationale: { type: "string", minLength: 12, maxLength: 260 } } } } } }) });
    const payload = await response.json().catch(() => null);
    if (response.ok) return asDecision(JSON.parse(responseText(payload)));
    if (response.status !== 429 && response.status < 500) throw new Error(`OpenAI ${response.status}: ${responseText(payload).slice(0, 240)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (i + 1)));
  }
  throw new Error("OpenAI retry limit reached.");
}

async function load(granularity: string, until: string, needed: number) {
  const result = new Map<string, ResearchCandle>();
  let to = until;
  while (result.size < needed) {
    const batch = await getResearchCandles("EUR_USD", granularity, 5_000, { to });
    if (!batch.length) break;
    for (const candle of batch) result.set(candle.time, candle);
    const first = batch.map((c) => c.time).sort()[0]!;
    if (first >= to) break;
    to = first;
    if (Date.parse(first) < Date.parse(start) - 30 * 24 * 60 * 60_000) break;
  }
  return [...result.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function score(direction: Direction, reference: number, future: ResearchCandle[], baseTime: number, minutes: number) {
  const cutoff = baseTime + minutes * 60_000;
  const endpoint = future.find((c) => Date.parse(c.time) >= cutoff);
  if (!endpoint) return { endpoint: null, correct: null, mfe: null, mae: null };
  const signed = (v: number) => (direction === "long" ? v - reference : reference - v) / pip;
  const movement = signed(endpoint.mid.close);
  const within = future.filter((c) => Date.parse(c.time) <= cutoff);
  const moves = within.flatMap((c) => direction === "long" ? [signed(c.mid.high), signed(c.mid.low)] : [signed(c.mid.low), signed(c.mid.high)]);
  return { endpoint: movement, correct: movement > 0, mfe: Math.max(0, ...moves), mae: Math.max(0, ...moves.map((v) => -v)) };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const shardSuffix = shardCount === 1 ? "" : `-shard-${shardIndex}-of-${shardCount}`;
  const cachePath = path.join(outDir, `sep14-restored-analyzer-${arg}-replay${shardSuffix}.json`);
  const prior: Row[] = await readFile(cachePath, "utf8").then((s) => JSON.parse(s) as Row[]).catch(() => []);
  const rows = new Map(prior.map((r) => [r.decisionTime, r]));
  const m15 = await load("M15", new Date(Date.parse(end) + 4 * 60 * 60_000).toISOString(), 11_000);
  const h1 = await load("H1", end, 3_000);
  const candidates = m15.filter((c) => {
    const t = Date.parse(c.time) + 15 * 60_000;
    const iso = new Date(t).toISOString();
    return c.complete && iso >= start && iso < end && (arg === "sep14" || new Date(t).getUTCMinutes() === 0);
  });
  const decisions = candidates.filter((_, index) => index % shardCount === shardIndex);
  console.error(`mode=${arg} candidates=${decisions.length} cached=${rows.size}`);
  for (let i = 0; i < decisions.length; i++) {
    const c = decisions[i]!; const t = Date.parse(c.time) + 15 * 60_000; const at = new Date(t).toISOString();
    if (rows.has(at)) continue;
    const visible15 = m15.filter((x) => completedAt(x, t)).slice(-32);
    const visibleH1 = h1.filter((x) => x.complete && Date.parse(x.time) + 60 * 60_000 <= t).slice(-32);
    if (visible15.length < 32 || visibleH1.length < 32) continue;
    const decision = await ask(at, visible15, visibleH1);
    const future = m15.filter((x) => Date.parse(x.time) + 15 * 60_000 > t && Date.parse(x.time) + 15 * 60_000 <= t + 4 * 60 * 60_000);
    const endpointPips = {} as Row["endpointPips"]; const correct = {} as Row["correct"]; const mfePips = {} as Row["mfePips"]; const maePips = {} as Row["maePips"];
    for (const [key, minutes] of Object.entries(horizons) as [keyof typeof horizons, number][]) { const s = score(decision.direction, c.mid.close, future.map((x) => ({ ...x, time: new Date(Date.parse(x.time) + 15 * 60_000).toISOString() })), t, minutes); endpointPips[key] = s.endpoint; correct[key] = s.correct; }
    for (const [key, minutes] of Object.entries(excursionHorizons) as [keyof typeof excursionHorizons, number][]) { const s = score(decision.direction, c.mid.close, future.map((x) => ({ ...x, time: new Date(Date.parse(x.time) + 15 * 60_000).toISOString() })), t, minutes); mfePips[key] = s.mfe; maePips[key] = s.mae; }
    rows.set(at, { decisionTime: at, candleStart: c.time, pair: "EUR_USD", direction: decision.direction, confidence: decision.confidence, referenceMid: c.mid.close, entry: decision.direction === "long" ? c.ask.close : c.bid.close, riskPips: decision.riskPips, endpointPips, correct, mfePips, maePips, rationale: decision.rationale });
    if ((i + 1) % 5 === 0 || i === decisions.length - 1) { await writeFile(cachePath, JSON.stringify([...rows.values()].sort((a, b) => a.decisionTime.localeCompare(b.decisionTime)), null, 2)); console.error(`saved ${i + 1}/${decisions.length}`); }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
