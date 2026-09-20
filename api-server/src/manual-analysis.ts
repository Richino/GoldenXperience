import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { currenciesOf, pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
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
  analyzedAt: string;
  testOnly: true;
};

type ModelDecision = {
  direction?: unknown;
  confidence?: unknown;
  riskPips?: unknown;
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

function candlesForPrompt(candles: Array<{ time: string; open: number; high: number; low: number; close: number }>) {
  return candles.slice(-32).map((candle) => ({
    t: candle.time,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
  }));
}

/**
 * Runs only when the owner explicitly clicks Analyze. It is intentionally
 * separate from every strategy/paper-cycle route: a proposal cannot create an
 * order, a pending entry, or a paper trade.
 */
export async function createManualTradeProposal(instrument: MajorInstrument): Promise<ManualTradeProposal> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Manual analysis is not configured. Add OPENAI_API_KEY to api-server/.env.");

  const [pricing, m15, h1, calendar] = await Promise.all([
    getPricing([instrument]),
    getCandles(instrument, "M15", 96),
    getCandles(instrument, "H1", 72),
    getEconomicCalendar(),
  ]);
  const quote = pricing.data[0];
  const market = getForexSessionStatus();
  if (pricing.status.state !== "connected" || !quote || !(quote.bid > 0) || !(quote.ask >= quote.bid)) {
    throw new Error("A fresh OANDA quote is required before analysis can run.");
  }
  if (m15.status.state !== "connected" || h1.status.state !== "connected") {
    throw new Error("Fresh OANDA chart data is required before analysis can run.");
  }
  if (!calendar.data.connected) {
    throw new Error("ForexFactory calendar data is unavailable. Check news manually before analyzing.");
  }

  const { base, quote: quoteCurrency } = currenciesOf(instrument);
  const pairEvents = calendar.data.events
    .filter((event) => event.currency === base || event.currency === quoteCurrency)
    .slice(0, 6)
    .map((event) => ({
      time: event.timestamp,
      currency: event.currency,
      impact: event.impact,
      title: event.title,
    }));
  const price = { bid: quote.bid, ask: quote.ask, mid: quote.mid, time: quote.time };
  const prompt = JSON.stringify({
    task: "Produce one forced, test-only manual forex trade proposal. This is not an order and must never be described as certain or guaranteed.",
    instrument,
    executablePrice: price,
    marketCondition: {
      marketOpen: market.marketOpen,
      session: market.label,
      checkedAt: new Date().toISOString(),
    },
    spreadPips: (quote.ask - quote.bid) / pipSizeFor(instrument),
    candles: { m15: candlesForPrompt(m15.data.candles), h1: candlesForPrompt(h1.data.candles) },
    upcomingRelevantCalendar: pairEvents,
    requiredOutput: {
      direction: "long or short",
      confidence: "integer 1 through 100; calibration, not probability of profit",
      riskPips: "number from 8 through 40",
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
  const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini",
      reasoning: { effort: "low" },
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "manual_forex_proposal",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["direction", "confidence", "riskPips", "preferredEntryTime", "rationale"],
            properties: {
              direction: { type: "string", enum: ["long", "short"] },
              confidence: { type: "integer", minimum: 1, maximum: 100 },
              riskPips: { type: "number", minimum: 8, maximum: 40 },
              preferredEntryTime: { type: "string", minLength: 6, maxLength: 140 },
              rationale: { type: "string", minLength: 12, maxLength: 260 },
            },
          },
        },
      },
    }),
  });
  const openAiPayload = await openAiResponse.json().catch(() => null) as unknown;
  if (!openAiResponse.ok) {
    const detail = responseText(openAiPayload) || "The analysis model could not respond.";
    throw new Error(`Manual analysis failed: ${detail.slice(0, 240)}`);
  }

  let decision: ModelDecision;
  try {
    decision = JSON.parse(responseText(openAiPayload)) as ModelDecision;
  } catch {
    throw new Error("Manual analysis returned an unreadable proposal. Try again.");
  }
  const direction = decision.direction === "long" || decision.direction === "short" ? decision.direction : null;
  const confidence = numberInRange(decision.confidence, 1, 100);
  const riskPips = numberInRange(decision.riskPips, 8, 40);
  const preferredEntryTime = typeof decision.preferredEntryTime === "string" ? decision.preferredEntryTime.trim().slice(0, 140) : "";
  const rationale = typeof decision.rationale === "string" ? decision.rationale.trim().slice(0, 260) : "";
  if (!direction || confidence === null || riskPips === null || preferredEntryTime.length < 6 || rationale.length < 12) {
    throw new Error("Manual analysis returned an invalid proposal. Try again.");
  }

  const pip = pipSizeFor(instrument);
  const entry = direction === "long" ? quote.ask : quote.bid;
  const risk = riskPips * pip;
  const stop = direction === "long" ? entry - risk : entry + risk;
  const target = direction === "long" ? entry + risk * 2 : entry - risk * 2;
  const precision = precisionFor(instrument);
  const format = (value: number) => Number(value.toFixed(precision));
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
    analyzedAt: new Date().toISOString(),
    testOnly: true,
  };
}
