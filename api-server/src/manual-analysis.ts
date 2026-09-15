import { getAllCalendarEvents, getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { currenciesOf, pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import { ingestCalendarEvents, persistedCalendarCoverage, upcomingCalendarEventsForCurrencies } from "./news-tagging.js";
import type { MajorInstrument } from "./market-stream-types.js";

export type ManualTradeProposal = {
  instrument: MajorInstrument;
  direction: "long" | "short";
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  preferredEntryTime: string;
  rationale: string;
  newsSummary: string;
  /** Set only when the app adjusted the model's numbers, e.g. widened the stop to clear the spread. */
  notice?: string;
  analyzedAt: string;
  testOnly: true;
};

type ModelDecision = {
  direction?: unknown;
  confidence?: unknown;
  riskPips?: unknown;
  entryType?: unknown;
  entry?: unknown;
  preferredEntryTime?: unknown;
  rationale?: unknown;
};

function numberInRange(value: unknown, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function responseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";
  return response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("\n");
}

/** Candles handed back to the model, compacted to just OHLC + time. */
function compactCandles(candles: Array<{ time: string; open: number; high: number; low: number; close: number }>) {
  return candles.map((candle) => ({
    t: candle.time,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
  }));
}

/** Timeframes the model may request through get_candles. */
const ALLOWED_TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D"] as const;
/** Bounds on how much data one get_candles call returns. */
const MIN_CANDLES = 10;
const MAX_CANDLES = 300;
/** Hard cap on tool-calling rounds so one analyze can never loop or bill forever. */
const MAX_TOOL_ROUNDS = 6;

type ResponsesOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};
type ResponsesPayload = {
  id?: string;
  output?: ResponsesOutputItem[];
};
type ResponsesInputItem =
  | { role: "user"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

function clampCount(value: unknown): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(MAX_CANDLES, Math.max(MIN_CANDLES, parsed));
}

/**
 * Runs only when the owner explicitly clicks Analyze. It is intentionally
 * separate from every strategy/paper-cycle route: a proposal cannot create an
 * order, a pending entry, or a paper trade.
 *
 * The model reads the chart itself: rather than being handed a fixed slice of
 * candles, it calls get_candles / get_calendar as many times as it needs (up to
 * MAX_TOOL_ROUNDS) and then commits through submit_proposal. All numeric limits,
 * entry validation, and the spread / 2R math stay in this function.
 */
export async function createManualTradeProposal(instrument: MajorInstrument): Promise<ManualTradeProposal> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Manual analysis is not configured. Add OPENAI_API_KEY to api-server/.env.");

  // Only the execution context is fetched upfront: the price we must convert the
  // entry against, and the news gate. The chart itself is left for the model to
  // pull through get_candles.
  const [pricing, calendar] = await Promise.all([
    getPricing([instrument]),
    getEconomicCalendar(),
  ]);
  const quote = pricing.data[0];
  const market = getForexSessionStatus();
  if (pricing.status.state !== "connected" || !quote || !(quote.bid > 0) || !(quote.ask >= quote.bid)) {
    throw new Error("A fresh OANDA quote is required before analysis can run.");
  }
  const { base, quote: quoteCurrency } = currenciesOf(instrument);
  type PairEvent = { time: string; currency: string; impact: number; title: string; forecast: string | null; previous: string | null; actual: string | null };
  let pairEvents: PairEvent[];
  if (calendar.data.connected) {
    pairEvents = calendar.data.events
      .filter((event) => event.currency === base || event.currency === quoteCurrency)
      .slice(0, 6)
      .map((event) => ({
        time: event.timestamp,
        currency: event.currency,
        impact: event.impact,
        title: event.title,
        forecast: event.forecast,
        previous: event.previous,
        actual: event.actual,
      }));
    // Warm the persisted calendar so a later analyze can fall back to it when the
    // feed is rate limited. getAllCalendarEvents shares the same in-memory cache
    // as the fetch above, so this adds no extra request to the throttled feed.
    void getAllCalendarEvents()
      .then((events) => (events.length ? ingestCalendarEvents(events) : null))
      .catch((error) => console.error("[manual-analysis] calendar cache warm failed", error));
  } else {
    // Live feed unavailable — almost always a ForexFactory 429. Fall back to the
    // calendar we persisted on the last successful analyze/retag. The feed only
    // ever publishes the current week, so a recent stored copy answers the same
    // news question the live feed would have.
    const [storedEvents, coverage] = await Promise.all([
      upcomingCalendarEventsForCurrencies([base, quoteCurrency], 6).catch(() => []),
      persistedCalendarCoverage().catch(() => 0),
    ]);
    if (coverage === 0) {
      throw new Error("ForexFactory calendar data is unavailable and no cached calendar is stored yet. Check news manually before analyzing.");
    }
    pairEvents = storedEvents.map((event) => ({
      time: event.timestamp,
      currency: event.currency,
      impact: event.impact,
      title: event.title,
      forecast: event.forecast ?? null,
      previous: event.previous ?? null,
      actual: event.actual ?? null,
    }));
  }

  const price = { bid: quote.bid, ask: quote.ask, mid: quote.mid, time: quote.time };
  const seedPrompt = JSON.stringify({
    task: "Produce one forced, test-only manual forex trade proposal. This is not an order and must never be described as certain or guaranteed.",
    instrument,
    executablePrice: price,
    marketCondition: {
      marketOpen: market.marketOpen,
      session: market.label,
      checkedAt: new Date().toISOString(),
    },
    spreadPips: (quote.ask - quote.bid) / pipSizeFor(instrument),
    dataAccess: "You are not given candles. Call get_candles yourself to read the chart, and get_calendar to check news. Pull whatever timeframes and depth you need, then call submit_proposal exactly once.",
    requiredProposal: {
      direction: "long or short",
      confidence: "integer 1 through 100; calibration, not probability of profit",
      riskPips: "number from 8 through 40",
      entryType: "market, pullback, or breakout. market = enter at the current price now. pullback = wait for price to pull back to a support/resistance level before entering. breakout = enter as price pushes through a level.",
      entry: "the exact price to enter at. For market use the current price. For pullback set it at the support/resistance level you expect price to reach; for breakout set it just beyond the level that must give way. Keep it inside the range of the candles you fetched.",
      preferredEntryTime: "short, specific timing guidance in ET, such as 'Enter now only after a 15m close below 110.68' or 'Wait for the 8:30-10:30 AM ET window'",
      rationale: "two short sentences in plain beginner English explaining why BUY or SELL is suggested and what could make it wrong",
    },
    rules: [
      "Read the chart before deciding: use get_candles across the timeframes you need (e.g. H4/H1 for structure, M15/M5 for the entry level) until you have enough to judge support, resistance and the trend. Use get_calendar to check upcoming news.",
      "You must choose exactly one direction because this screen is a forced-proposal test.",
      "Use only data returned by the tools. Do not browse, invent news, or promise a result.",
      "Choose the entry deliberately from price structure. Prefer a pullback to a support/resistance level or a breakout beyond one over entering at the current price, unless price is already sitting at the level you want. Pick a real level from the candles, not a round guess.",
      "Entry side must be consistent: for a long, a pullback entry sits at or below the current price and a breakout entry at or above it; for a short, a pullback entry sits at or above and a breakout entry at or below. Keep entry within the range of the candles you fetched.",
      "The application converts your entry to an executable price and calculates the stop and the exact 2R target from your entry and riskPips.",
      "If marketOpen is false, do not say enter now. State that the market is closed and tell the user to reassess after it reopens.",
      "Write the rationale for a beginner. Avoid jargon such as lower highs, momentum, support, resistance, breakout, or liquidity. Say plainly whether buyers or sellers are in control and name the price that would make the idea wrong.",
    ],
  });

  const proposalSchema = {
    type: "object",
    additionalProperties: false,
    required: ["direction", "confidence", "riskPips", "entryType", "entry", "preferredEntryTime", "rationale"],
    properties: {
      direction: { type: "string", enum: ["long", "short"] },
      confidence: { type: "integer", minimum: 1, maximum: 100 },
      riskPips: { type: "number", minimum: 8, maximum: 40 },
      entryType: { type: "string", enum: ["market", "pullback", "breakout"] },
      entry: { type: "number", minimum: 0 },
      preferredEntryTime: { type: "string", minLength: 6, maxLength: 140 },
      rationale: { type: "string", minLength: 12, maxLength: 260 },
    },
  } as const;
  const tools = [
    {
      type: "function",
      name: "get_candles",
      description: "Fetch the most recent OHLC candles for this instrument at a timeframe. Call it as often as you need, across timeframes and depths, to read the chart before deciding.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["timeframe", "count"],
        properties: {
          timeframe: { type: "string", enum: [...ALLOWED_TIMEFRAMES] },
          count: { type: "integer", minimum: MIN_CANDLES, maximum: MAX_CANDLES, description: "How many of the most recent candles to return." },
        },
      },
    },
    {
      type: "function",
      name: "get_calendar",
      description: "Upcoming economic calendar events for this pair's two currencies, including forecast, previous and actual values where known.",
      strict: true,
      parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    },
    {
      type: "function",
      name: "submit_proposal",
      description: "Submit the final trade proposal. Call this exactly once, only after you have read enough chart data.",
      strict: true,
      parameters: proposalSchema,
    },
  ];

  // The band a pullback/breakout entry must fall inside is tied to the candles
  // the model actually pulled, so validation reflects the same data it saw.
  let observedHigh = Number.NEGATIVE_INFINITY;
  let observedLow = Number.POSITIVE_INFINITY;
  let sawLiveCandles = false;

  async function runTool(name: string | undefined, rawArgs: string | undefined): Promise<unknown> {
    let args: Record<string, unknown> = {};
    if (rawArgs) { try { args = JSON.parse(rawArgs) as Record<string, unknown>; } catch { args = {}; } }
    if (name === "get_calendar") {
      console.log(`[manual-analysis] ${instrument} tool get_calendar → ${pairEvents.length} events`);
      return { events: pairEvents, connected: calendar.data.connected };
    }
    if (name === "get_candles") {
      const timeframe = ALLOWED_TIMEFRAMES.includes(args.timeframe as typeof ALLOWED_TIMEFRAMES[number])
        ? (args.timeframe as string)
        : "H1";
      const count = clampCount(args.count);
      const series = await getCandles(instrument, timeframe, count);
      const connected = series.status.state === "connected";
      console.log(`[manual-analysis] ${instrument} tool get_candles ${timeframe} x${count} → ${series.data.candles.length} candles (${series.status.state})`);
      if (connected) {
        sawLiveCandles = true;
        for (const candle of series.data.candles) {
          if (candle.high > observedHigh) observedHigh = candle.high;
          if (candle.low < observedLow) observedLow = candle.low;
        }
      }
      return {
        timeframe,
        connected,
        status: series.status.state,
        returned: series.data.candles.length,
        candles: compactCandles(series.data.candles),
      };
    }
    return { error: `Unknown tool: ${name ?? "(none)"}` };
  }

  const model = process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini";
  const effort = process.env.OPENAI_ANALYSIS_EFFORT?.trim() || "low";
  let decision: ModelDecision | null = null;
  let previousResponseId: string | undefined;
  let nextInput: ResponsesInputItem[] = [{ role: "user", content: seedPrompt }];

  for (let round = 0; round < MAX_TOOL_ROUNDS && !decision; round += 1) {
    // On the final round force the model to commit so the loop always terminates
    // with a proposal instead of asking for yet more data.
    const forceSubmit = round === MAX_TOOL_ROUNDS - 1;
    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        reasoning: { effort },
        input: nextInput,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        tools,
        tool_choice: forceSubmit ? { type: "function", name: "submit_proposal" } : "auto",
      }),
    });
    const payload = await openAiResponse.json().catch(() => null) as ResponsesPayload | null;
    if (!openAiResponse.ok || !payload) {
      const detail = responseText(payload) || "The analysis model could not respond.";
      throw new Error(`Manual analysis failed: ${detail.slice(0, 240)}`);
    }
    previousResponseId = payload.id;
    const output = Array.isArray(payload.output) ? payload.output : [];
    const functionCalls = output.filter((item) => item.type === "function_call");

    const submit = functionCalls.find((call) => call.name === "submit_proposal");
    if (submit) {
      try {
        decision = JSON.parse(submit.arguments ?? "{}") as ModelDecision;
      } catch {
        throw new Error("Manual analysis returned an unreadable proposal. Try again.");
      }
      break;
    }

    if (functionCalls.length === 0) {
      // The model answered without calling a tool. Nudge it to commit.
      nextInput = [{ role: "user", content: "Call submit_proposal now with your final decision." }];
      continue;
    }

    const outputs: ResponsesInputItem[] = [];
    for (const call of functionCalls) {
      const result = await runTool(call.name, call.arguments);
      outputs.push({ type: "function_call_output", call_id: call.call_id ?? "", output: JSON.stringify(result) });
    }
    nextInput = outputs;
  }

  if (!decision) {
    throw new Error("Manual analysis did not produce a proposal. Try again.");
  }
  if (!sawLiveCandles) {
    throw new Error("Fresh OANDA chart data was unavailable during analysis. Try again shortly.");
  }

  const direction = decision.direction === "long" || decision.direction === "short" ? decision.direction : null;
  const confidence = numberInRange(decision.confidence, 1, 100);
  const riskPips = numberInRange(decision.riskPips, 8, 40);
  const entryType = decision.entryType === "pullback" || decision.entryType === "breakout" || decision.entryType === "market"
    ? decision.entryType
    : "market";
  const proposedEntry = typeof decision.entry === "number" && Number.isFinite(decision.entry) ? decision.entry : null;
  const preferredEntryTime = typeof decision.preferredEntryTime === "string" ? decision.preferredEntryTime.trim().slice(0, 140) : "";
  const rationale = typeof decision.rationale === "string" ? decision.rationale.trim().slice(0, 260) : "";
  if (!direction || confidence === null || riskPips === null || preferredEntryTime.length < 6 || rationale.length < 12) {
    throw new Error("Manual analysis returned an invalid proposal. Try again.");
  }

  const pip = pipSizeFor(instrument);
  const halfSpread = (quote.ask - quote.bid) / 2;
  const mid = quote.mid;

  // Pick the level the AI wants to enter at. Default to the current price
  // (market). A pullback/breakout entry is only honored when it is a sane
  // number: inside the recent high-low range and on the correct side of the
  // current price for its type. Anything else falls back to market so a bad
  // model number can never produce a nonsensical entry.
  let level = mid;
  if (entryType !== "market" && proposedEntry !== null) {
    const bandBuffer = 5 * pip;
    // Band comes from the candles the model actually fetched during this run.
    const upper = Number.isFinite(observedHigh) ? observedHigh + bandBuffer : Number.POSITIVE_INFINITY;
    const lower = Number.isFinite(observedLow) ? observedLow - bandBuffer : Number.NEGATIVE_INFINITY;
    const withinRange = proposedEntry <= upper && proposedEntry >= lower;
    const correctSide = direction === "long"
      ? (entryType === "pullback" ? proposedEntry <= mid : proposedEntry >= mid)
      : (entryType === "pullback" ? proposedEntry >= mid : proposedEntry <= mid);
    if (withinRange && correctSide) level = proposedEntry;
  }

  // Convert the chosen mid-level to an executable price by paying the spread on
  // the correct side. When level is the current mid (market), this reproduces
  // the previous ask/bid behavior exactly.
  const entry = direction === "long" ? level + halfSpread : level - halfSpread;

  // Stop-to-spread guard. On this account the spread is the whole loss, so a
  // stop that is only a few multiples of the spread bleeds most of its risk to
  // cost before direction even matters. Enforce a floor: the stop must be at
  // least MIN_STOP_TO_SPREAD times the current spread. If the model asked for a
  // tighter stop we widen it (target moves with it, R:R stays 2:1); if even the
  // 40-pip max cannot clear the floor, the spread is too wide to trade now.
  const minStopToSpread = Number(process.env.MANUAL_ANALYSIS_MIN_STOP_SPREAD) || 8;
  const spreadPips = (quote.ask - quote.bid) / pip;
  const minRiskPips = spreadPips * minStopToSpread;
  if (minRiskPips > 40) {
    throw new Error(`Spread is too wide right now (${spreadPips.toFixed(1)} pips). A stop that clears the spread would exceed the 40-pip risk cap. Try again when the spread tightens.`);
  }
  const effectiveRiskPips = Math.max(riskPips, minRiskPips);
  const risk = effectiveRiskPips * pip;
  const stop = direction === "long" ? entry - risk : entry + risk;
  const target = direction === "long" ? entry + risk * 2 : entry - risk * 2;
  const precision = precisionFor(instrument);
  const format = (value: number) => Number(value.toFixed(precision));
  const widened = effectiveRiskPips > riskPips ? ` (widened from ${riskPips}p; spread ${spreadPips.toFixed(1)}p)` : "";
  const stopNotice = effectiveRiskPips > riskPips
    ? `Stop widened to ${effectiveRiskPips.toFixed(1)} pips (model asked ${riskPips}) so it clears the ${spreadPips.toFixed(1)}-pip spread. Target moved with it; risk-reward stays 2:1.`
    : undefined;
  console.log(`[manual-analysis] ${instrument} decision: ${direction} ${entryType} entry=${format(entry)} risk=${effectiveRiskPips.toFixed(1)}p${widened} conf=${Math.round(confidence)}`);
  const nextNews = pairEvents[0];
  const newsImpact = (impact: number) => impact >= 3
    ? "High impact — this can move the pair fast, so avoid entering close to the release."
    : impact === 2
      ? "Medium impact — this can cause a short, choppy move."
      : "Low impact — this usually has a smaller effect on the pair.";
  return {
    instrument,
    direction,
    confidence: Math.round(confidence),
    entry: format(entry),
    stop: format(stop),
    target: format(target),
    riskReward: 2,
    // Closed-market prices are not executable. Do not let a forced test
    // proposal turn an old Friday quote into an instruction to enter now.
    preferredEntryTime: market.marketOpen
      ? preferredEntryTime
      : "Market closed — do not enter. Re-run analysis after forex reopens for a fresh price and timing.",
    rationale,
    newsSummary: nextNews
      ? `${newsImpact(nextNews.impact)} Next: ${nextNews.currency} ${nextNews.title} at ${new Date(nextNews.time).toLocaleString("en-US", { timeZone: "America/New_York", timeStyle: "short", dateStyle: "medium" })} ET.`
      : "No relevant upcoming events were returned by the current ForexFactory feed.",
    ...(stopNotice ? { notice: stopNotice } : {}),
    analyzedAt: new Date().toISOString(),
    testOnly: true,
  };
}
