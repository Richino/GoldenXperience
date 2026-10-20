import { randomUUID } from "node:crypto";
import { readMarketTechnicals, type InterpretMarketInput } from "../../src/intelligence/market-state-interpreter.js";
import type { Factor, MarketIntelligence } from "../../src/intelligence/research-contract.js";
import type { Candle } from "../../../frontend/src/types/forex.js";
const NOW = Date.parse("2026-10-14T12:00:00Z"), HOUR = 3_600_000;
const factor = (id: string, patch: Partial<Factor> = {}): Factor => ({ id, factor: "US yields retreat", currency: "USD", effectOnCurrency: "weakens", impactOnPair: "bullish", importance: "high", evidenceType: "attributed_analysis", description: "Treasury yields fell as Fed tightening expectations receded.", observedAt: new Date(NOW - HOUR).toISOString(), uncertainty: null, sourceIds: ["s1"], ...patch });
export function input(): InterpretMarketInput {
  const candles = (step: number): Candle[] => Array.from({ length: 300 }, (_, i) => {
    const open = 1.11 + i * 0.00004 + Math.sin(i * 0.4) * 0.002;
    const close = 1.11 + (i + 1) * 0.00004 + Math.sin((i + 1) * 0.4) * 0.002;
    return { time: new Date(NOW - (300 - i) * step).toISOString(), open, close, high: Math.max(open, close) + 0.0005, low: Math.min(open, close) - 0.0005, volume: 100, complete: true };
  });
  const market = { instrument: "EUR_USD" as const, now: NOW, quote: { bid: 1.12, ask: 1.1201, time: new Date(NOW).toISOString() }, candles: { H1: candles(HOUR), H4: candles(4 * HOUR), D1: candles(24 * HOUR) } };
  const technical = readMarketTechnicals(market);
  const intel: MarketIntelligence = {
    schemaVersion: "2.1", pair: "EUR_USD", base: "EUR", quote: "USD",
    research: { id: randomUUID(), createdAt: new Date(NOW - 120_000).toISOString(), cutoffAt: new Date(NOW - 120_000).toISOString(), horizon: "2-5 trading days", status: "complete", quality: "medium", missingData: [], model: "test", effort: "medium", durationMs: 1000 },
    outlook: { overall: "mixed", shortTerm: "bullish", swingTerm: "mixed", fundamental: "mixed", technical: "bearish", explanation: "Research narrative, not observed price." },
    factors: [factor("F1"), factor("F2", { factor: "ECB outlook improves", currency: "EUR", effectOnCurrency: "strengthens", description: "Euro-area employment improves.", sourceIds: ["s2"] })],
    sources: ["s1", "s2"].map(id => ({ id, url: `https://example.com/${id}`, publisher: "Fixture wire", title: "Fixture", retrievedAt: new Date(NOW).toISOString(), publishedAt: null, type: "news", verification: "returned_by_search" })),
    events: [], sentiment: { professional: [], retail: [], positioning: [], expectations: "", limitations: "" },
    bullishThesis: { hypothesis: "Recovery continuation if its own price conditions confirm.", supportingFactorIds: ["F1"], opposingFactorIds: [], catalysts: [], strengthensIf: ["A completed bullish break"], weakensIf: ["A failed reclaim"] },
    bearishThesis: { hypothesis: "Downtrend continuation after rejection.", supportingFactorIds: [], opposingFactorIds: ["F1"], catalysts: [], strengthensIf: ["A completed bearish break"], weakensIf: ["A sustained recovery"] }, summary: "Fixture research.",
  };
  return { intelligence: intel, market, technical, researchFresh: true, calendar: { source: "forex_factory", readAt: new Date(NOW - 120_000).toISOString(), available: true, currencies: ["EUR", "USD"], upcoming: [], released: [], revisions: "unavailable", note: null } };
}