import { canonicalUrl, plainText } from "./research-report.js";

/**
 * Market Intelligence contract, v2 — the machine-readable research the trade
 * plan engine consumes.
 *
 * Who owns what:
 *   GPT          factors (which currency, strengthens or weakens, importance,
 *                evidence type, cited URLs), sentiment by source type, the two
 *                research theses, and qualitative biases.
 *   The server   ids, timestamps, the source registry, the verified calendar
 *                events, the technical bias (from the technical engine), and
 *                every factor's impact on the PAIR — derived from base/quote,
 *                so "USD weakens" is bullish EUR/USD and bearish USD/JPY.
 *
 * Validation (validateResearch) rejects malformed answers, maps cited URLs to
 * registry source ids and drops anything citing a URL the search did not
 * return, checks factor and event references, and records every drop. Schema-
 * valid is not the same as true: numbers in prose are not trusted as data;
 * calendar figures come only from the calendar provider.
 */

export const RESEARCH_SCHEMA_VERSION = "2.1";
/** 2.0 snapshots (no directional assessment) are still valid for plans and display. */
export const SUPPORTED_SCHEMA_VERSIONS = ["2.0", "2.1"];
export const isSupportedSchema = (version: unknown) => typeof version === "string" && SUPPORTED_SCHEMA_VERSIONS.includes(version);

export type Bias = "bullish" | "bearish" | "mixed" | "neutral" | "unknown";
export type Quality = "high" | "medium" | "low";
export type CurrencyEffect = "strengthens" | "weakens" | "mixed" | "unclear";
export type EvidenceType = "verified_data" | "attributed_analysis" | "hypothesis";
export type Lean = "bullish" | "bearish" | "neutral" | "unresolved";

/**
 * Which way the cited evidence leans, per horizon. A lean must be carried by
 * cited factors on that side that outweigh the other side; otherwise the
 * server sets it to "unresolved". This is an evidence summary, not a
 * probability of any trade working, and it never selects a trade.
 */
export type DirectionalAssessment = {
  nearTermLean: Lean;
  swingLean: Lean;
  /** Server-computed from importance-weighted cited factors. */
  evidenceBalance: { bullish: number; bearish: number; strongerSide: "bullish" | "bearish" | "neither" };
  drivers: string[];
  strongestOpposing: string;
  changeTriggers: string[];
  rationale: string;
  supportingFactorIds: string[];
};

export type Source = {
  id: string;
  url: string;
  publisher: string;
  title: string | null;
  /** When the server retrieved it (the research run). */
  retrievedAt: string;
  /** Only when the model reported it; otherwise null (not invented). */
  publishedAt: string | null;
  type: "official" | "news" | "analysis" | "forum" | "other";
  verification: "returned_by_search";
};

export type Factor = {
  id: string;
  factor: string;
  currency: string;
  effectOnCurrency: CurrencyEffect;
  /** Server-derived: what the effect means for THIS pair. */
  impactOnPair: Bias;
  importance: Quality;
  evidenceType: EvidenceType;
  description: string;
  observedAt: string | null;
  uncertainty: string | null;
  sourceIds: string[];
};

export type CalendarEventRef = {
  id: string;
  title: string;
  currency: string;
  impact: number;
  at: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  revised: null;
  status: "released" | "scheduled";
  source: string;
  /** GPT's reading of what the release may mean; null when it gave none. */
  implication: string | null;
};

export type Observation = { text: string; stance: "bullish" | "bearish" | "neutral" | "mixed"; sourceIds: string[] };

export type ResearchThesis = {
  hypothesis: string;
  supportingFactorIds: string[];
  opposingFactorIds: string[];
  catalysts: string[];
  strengthensIf: string[];
  weakensIf: string[];
};

export type MarketIntelligence = {
  schemaVersion: string;
  pair: string;
  base: string;
  quote: string;
  research: {
    id: string;
    createdAt: string;
    cutoffAt: string;
    horizon: "2-5 trading days";
    status: "complete" | "partial";
    quality: Quality;
    missingData: string[];
    model: string;
    effort: string;
    durationMs: number;
  };
  outlook: {
    overall: Bias;
    shortTerm: Bias;
    swingTerm: Bias;
    fundamental: Bias;
    /** From the technical engine (D1/H4 structure), never from GPT. */
    technical: Bias;
    explanation: string;
  };
  factors: Factor[];
  events: CalendarEventRef[];
  sentiment: {
    professional: Observation[];
    retail: Observation[];
    positioning: Observation[];
    expectations: string;
    limitations: string;
  };
  bullishThesis: ResearchThesis;
  bearishThesis: ResearchThesis;
  /** Since 2.1. */
  assessment?: DirectionalAssessment;
  sources: Source[];
  summary: string;
};

// ── Model output schema (Structured Outputs: strict, all required) ─────────

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const nullableStr = { type: ["string", "null"] } as const;
const bias = { type: "string", enum: ["bullish", "bearish", "mixed", "neutral", "unknown"] } as const;
const quality = { type: "string", enum: ["high", "medium", "low"] } as const;
const observation = {
  type: "array",
  items: {
    type: "object", additionalProperties: false, required: ["text", "stance", "urls"],
    properties: { text: str, stance: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] }, urls: strArr },
  },
} as const;
const thesis = {
  type: "object", additionalProperties: false,
  required: ["hypothesis", "supportingFactorIds", "opposingFactorIds", "catalysts", "strengthensIf", "weakensIf"],
  properties: { hypothesis: str, supportingFactorIds: strArr, opposingFactorIds: strArr, catalysts: strArr, strengthensIf: strArr, weakensIf: strArr },
} as const;

export const MODEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["quality", "missingData", "outlook", "factors", "eventImplications", "sentiment", "bullishThesis", "bearishThesis", "assessment", "sourceDates", "summary"],
  properties: {
    quality,
    missingData: strArr,
    outlook: {
      type: "object", additionalProperties: false,
      required: ["overall", "shortTerm", "swingTerm", "fundamental", "explanation"],
      properties: { overall: bias, shortTerm: bias, swingTerm: bias, fundamental: bias, explanation: str },
    },
    factors: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "factor", "currency", "effectOnCurrency", "importance", "evidenceType", "description", "observedAt", "uncertainty", "urls"],
        properties: {
          id: str, factor: str, currency: str,
          effectOnCurrency: { type: "string", enum: ["strengthens", "weakens", "mixed", "unclear"] },
          importance: quality,
          evidenceType: { type: "string", enum: ["verified_data", "attributed_analysis", "hypothesis"] },
          description: str, observedAt: nullableStr, uncertainty: nullableStr, urls: strArr,
        },
      },
    },
    eventImplications: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["eventId", "implication"], properties: { eventId: str, implication: str } },
    },
    sentiment: {
      type: "object", additionalProperties: false,
      required: ["professional", "retail", "positioning", "expectations", "limitations"],
      properties: { professional: observation, retail: observation, positioning: observation, expectations: str, limitations: str },
    },
    bullishThesis: thesis,
    bearishThesis: thesis,
    assessment: {
      type: "object", additionalProperties: false,
      required: ["nearTermLean", "swingLean", "drivers", "strongestOpposing", "changeTriggers", "rationale", "supportingFactorIds"],
      properties: {
        nearTermLean: { type: "string", enum: ["bullish", "bearish", "neutral", "unresolved"] },
        swingLean: { type: "string", enum: ["bullish", "bearish", "neutral", "unresolved"] },
        drivers: strArr, strongestOpposing: str, changeTriggers: strArr, rationale: str, supportingFactorIds: strArr,
      },
    },
    sourceDates: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["url", "publisher", "publishedAt"], properties: { url: str, publisher: str, publishedAt: nullableStr } },
    },
    summary: str,
  },
} as const;

// ── Pair-relative direction (server-derived) ──────────────────────────────

/** What a currency move means for the pair: base strengthening is bullish, quote strengthening is bearish. */
export function impactOnPair(pair: string, currency: string, effect: CurrencyEffect): Bias {
  const [base, quote] = pair.toUpperCase().split("_");
  const c = currency.toUpperCase();
  if (effect === "mixed") return "mixed";
  if (effect === "unclear") return "unknown";
  if (c === base) return effect === "strengthens" ? "bullish" : "bearish";
  if (c === quote) return effect === "strengthens" ? "bearish" : "bullish";
  // A third currency (e.g. CNY) or a risk factor: no mechanical pair direction.
  return "unknown";
}

/** Technical bias from the engine's D1/H4 structure. */
export function technicalBias(trend: Record<string, string | null | undefined>): Bias {
  const d1 = trend.D1 ?? null;
  const h4 = trend.H4 ?? null;
  const dir = (t: string | null) => (t === "UPTREND" ? "bullish" : t === "DOWNTREND" ? "bearish" : t === "RANGE" ? "neutral" : null);
  const a = dir(d1);
  const b = dir(h4);
  if (!a && !b) return "unknown";
  if (a && b) return a === b ? a : "mixed";
  return (a ?? b)!;
}

// ── Validation ─────────────────────────────────────────────────────────────

const ENUM = {
  bias: ["bullish", "bearish", "mixed", "neutral", "unknown"],
  quality: ["high", "medium", "low"],
  effect: ["strengthens", "weakens", "mixed", "unclear"],
  evidence: ["verified_data", "attributed_analysis", "hypothesis"],
  stance: ["bullish", "bearish", "neutral", "mixed"],
};
const one = <T extends string>(value: unknown, allowed: string[]): T | null => (typeof value === "string" && allowed.includes(value) ? value as T : null);
const text = (value: unknown, max = 600) => (typeof value === "string" ? plainText(value).slice(0, max) : "");
const list = (value: unknown) => (Array.isArray(value) ? value : []);

function publisherOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; }
}
function sourceType(url: string): Source["type"] {
  const host = publisherOf(url);
  if (/(federalreserve\.gov|ecb\.europa\.eu|bankofengland|boj\.or\.jp|rba\.gov|bankofcanada|snb\.ch|rbnz|bls\.gov|bea\.gov|census\.gov|treasury\.gov|eurostat|ec\.europa\.eu|ons\.gov|destatis|statcan)/.test(host)) return "official";
  if (/(forexfactory|reddit|babypips\.com\/forum|tradingview\.com\/ideas|twitter|x\.com|stocktwits)/.test(host)) return "forum";
  if (/(reuters|bloomberg|apnews|wsj|ft\.com|cnbc|marketwatch|nikkei|marketscreener|aol\.com|yahoo)/.test(host)) return "news";
  if (/(fxstreet|dailyfx|investing\.com|forex\.com|ig\.com|sucden|ing\.com|think\.ing|saxo|oanda\.com|kitco)/.test(host)) return "analysis";
  return "other";
}

export type ValidationDrop = { where: string; reason: string; value: unknown };
export type ContractResult = { ok: true; intelligence: MarketIntelligence; drops: ValidationDrop[] } | { ok: false; reason: string; drops: ValidationDrop[] };

/**
 * Validate a model answer and turn it into a MarketIntelligence snapshot.
 * `searchUrls` are every URL the web search returned in this run (the only
 * acceptable citations). `calendar` are the verified events given to the
 * model, keyed by the ids it was shown.
 */
export function validateResearch(raw: unknown, input: {
  pair: string;
  searchUrls: Array<{ url: string; title: string | null }>;
  calendar: Array<Omit<CalendarEventRef, "implication">>;
  technicalTrend: Record<string, string | null | undefined>;
  meta: { id: string; createdAt: string; model: string; effort: string; durationMs: number };
}): ContractResult {
  const drops: ValidationDrop[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, reason: "The answer was not a JSON object.", drops };
  const r = raw as Record<string, unknown>;
  const [base, quote] = input.pair.toUpperCase().split("_") as [string, string];
  if (!base || !quote) return { ok: false, reason: "Unknown pair.", drops };

  // Required top-level fields (strict schema should guarantee them; never assume).
  for (const key of ["quality", "outlook", "factors", "sentiment", "bullishThesis", "bearishThesis", "summary"]) {
    if (!(key in r)) return { ok: false, reason: `Missing required field: ${key}.`, drops };
  }
  const outlookRaw = (r.outlook ?? {}) as Record<string, unknown>;
  const outlookFields = ["overall", "shortTerm", "swingTerm", "fundamental"] as const;
  for (const key of outlookFields) {
    if (!one<Bias>(outlookRaw[key], ENUM.bias)) return { ok: false, reason: `Invalid outlook.${key}.`, drops };
  }
  const summary = text(r.summary, 800);
  if (!summary) return { ok: false, reason: "The answer had no summary.", drops };

  // Source registry: every URL the search returned, with a stable id.
  const createdAt = input.meta.createdAt;
  const datesByUrl = new Map<string, { publisher: string; publishedAt: string | null }>();
  for (const item of list(r.sourceDates)) {
    const s = item as Record<string, unknown>;
    const key = typeof s.url === "string" ? canonicalUrl(s.url) : null;
    if (!key) continue;
    const published = typeof s.publishedAt === "string" && Number.isFinite(Date.parse(s.publishedAt)) ? new Date(Date.parse(s.publishedAt)).toISOString() : null;
    // A publication date after the research cut-off is impossible: keep it unknown.
    datesByUrl.set(key, { publisher: text(s.publisher, 80), publishedAt: published && Date.parse(published) <= Date.parse(createdAt) + 60_000 ? published : null });
  }
  const registry = new Map<string, Source>();
  let n = 0;
  for (const result of input.searchUrls) {
    const key = canonicalUrl(result.url);
    if (!key || registry.has(key)) continue;
    n += 1;
    const dated = datesByUrl.get(key);
    registry.set(key, {
      id: `src_${String(n).padStart(3, "0")}`,
      url: result.url,
      publisher: dated?.publisher || publisherOf(result.url),
      title: result.title,
      retrievedAt: createdAt,
      publishedAt: dated?.publishedAt ?? null,
      type: sourceType(result.url),
      verification: "returned_by_search",
    });
  }
  const cite = (urls: unknown, where: string): string[] => {
    const ids: string[] = [];
    for (const url of list(urls)) {
      const key = typeof url === "string" ? canonicalUrl(url) : null;
      const source = key ? registry.get(key) : undefined;
      if (source) ids.push(source.id);
      else drops.push({ where, reason: "cited URL was not returned by the web search", value: url });
    }
    return [...new Set(ids)];
  };

  // Factors: valid currency of this pair (or a named third currency), cited, pair impact derived here.
  const factors: Factor[] = [];
  const factorIds = new Set<string>();
  for (const item of list(r.factors)) {
    const f = item as Record<string, unknown>;
    const id = text(f.id, 24);
    const effect = one<CurrencyEffect>(f.effectOnCurrency, ENUM.effect);
    const currency = text(f.currency, 8).toUpperCase();
    const sourceIds = cite(f.urls, `factor ${id || "?"}`);
    if (!id || factorIds.has(id)) { drops.push({ where: "factors", reason: "missing or duplicate factor id", value: id }); continue; }
    if (!effect || !/^[A-Z]{3}$/.test(currency)) { drops.push({ where: `factor ${id}`, reason: "invalid currency or effect", value: { currency, effect: f.effectOnCurrency } }); continue; }
    if (!sourceIds.length) { drops.push({ where: `factor ${id}`, reason: "no citation returned by the web search", value: text(f.factor, 120) }); continue; }
    if (typeof f.observedAt === "string" && Number.isFinite(Date.parse(f.observedAt)) && Date.parse(f.observedAt) > Date.parse(createdAt)) {
      drops.push({where:`factor ${id}`,reason:"observed event is after the research cutoff",value:f.observedAt}); continue;
    }
    const evidenceType = one<EvidenceType>(f.evidenceType, ENUM.evidence) ?? "hypothesis";
    factorIds.add(id);
    factors.push({
      id,
      factor: text(f.factor, 120),
      currency,
      effectOnCurrency: effect,
      impactOnPair: impactOnPair(input.pair, currency, effect),
      importance: one<Quality>(f.importance, ENUM.quality) ?? "low",
      evidenceType,
      description: text(f.description, 500),
      observedAt: typeof f.observedAt === "string" && Number.isFinite(Date.parse(f.observedAt)) ? new Date(Date.parse(f.observedAt)).toISOString() : null,
      uncertainty: typeof f.uncertainty === "string" && f.uncertainty.trim() ? text(f.uncertainty, 300) : null,
      sourceIds,
    });
  }

  // Calendar events: only the verified ones the model was shown; it may add an implication, never figures.
  const implications = new Map<string, string>();
  for (const item of list(r.eventImplications)) {
    const e = item as Record<string, unknown>;
    const id = text(e.eventId, 24);
    if (!input.calendar.some((event) => event.id === id)) { drops.push({ where: "eventImplications", reason: "unknown event id", value: id }); continue; }
    implications.set(id, text(e.implication, 300));
  }
  const events: CalendarEventRef[] = input.calendar.map((event) => ({ ...event, implication: implications.get(event.id) ?? null }));

  const observations = (value: unknown, where: string): Observation[] => list(value).flatMap((item) => {
    const o = item as Record<string, unknown>;
    const sourceIds = cite(o.urls, where);
    if (!sourceIds.length) { drops.push({ where, reason: "no citation returned by the web search", value: text(o.text, 120) }); return []; }
    return [{ text: text(o.text, 400), stance: one<Observation["stance"]>(o.stance, ENUM.stance) ?? "neutral", sourceIds }];
  });
  const sentimentRaw = (r.sentiment ?? {}) as Record<string, unknown>;
  const retail = observations(sentimentRaw.retail, "sentiment.retail");
  // Positioning must be data, not opinion: only official/news/analysis sources qualify.
  const positioning = observations(sentimentRaw.positioning, "sentiment.positioning").filter((o) => {
    const ok = o.sourceIds.some((id) => [...registry.values()].find((s) => s.id === id)?.type !== "forum");
    if (!ok) drops.push({ where: "sentiment.positioning", reason: "forum posts are not positioning data", value: o.text.slice(0, 80) });
    return ok;
  });

  const thesisOf = (value: unknown, where: string): ResearchThesis => {
    const t = (value ?? {}) as Record<string, unknown>;
    const refs = (ids: unknown) => list(ids).map((id) => text(id, 24)).filter((id) => {
      const known = factorIds.has(id);
      if (!known) drops.push({ where, reason: "unknown or dropped factor id", value: id });
      return known;
    });
    return {
      hypothesis: text(t.hypothesis, 400),
      supportingFactorIds: [...new Set(refs(t.supportingFactorIds))],
      opposingFactorIds: [...new Set(refs(t.opposingFactorIds))],
      catalysts: list(t.catalysts).map((c) => text(c, 200)).filter(Boolean).slice(0, 6),
      strengthensIf: list(t.strengthensIf).map((c) => text(c, 200)).filter(Boolean).slice(0, 6),
      weakensIf: list(t.weakensIf).map((c) => text(c, 200)).filter(Boolean).slice(0, 6),
    };
  };

  const outlook = {
    overall: one<Bias>(outlookRaw.overall, ENUM.bias)!,
    shortTerm: one<Bias>(outlookRaw.shortTerm, ENUM.bias)!,
    swingTerm: one<Bias>(outlookRaw.swingTerm, ENUM.bias)!,
    fundamental: one<Bias>(outlookRaw.fundamental, ENUM.bias)!,
    technical: technicalBias(input.technicalTrend),
    explanation: text(outlookRaw.explanation, 600),
  };
  // Without surviving evidence there is no basis for a fundamental direction: UNKNOWN, not MIXED.
  if (!factors.length) {
    if (outlook.fundamental !== "unknown") drops.push({ where: "outlook.fundamental", reason: "no cited factors survived; set to unknown", value: outlook.fundamental });
    outlook.fundamental = "unknown";
  }
  const assessment = assessmentOf(r.assessment, factors, drops);
  const missingData = list(r.missingData).map((m) => text(m, 160)).filter(Boolean).slice(0, 10);
  const status: "complete" | "partial" = factors.length >= 2 && drops.length < 10 ? "complete" : "partial";

  return {
    ok: true,
    drops,
    intelligence: {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      pair: input.pair.toUpperCase(),
      base,
      quote,
      research: {
        id: input.meta.id,
        createdAt,
        cutoffAt: createdAt,
        horizon: "2-5 trading days",
        status,
        quality: factors.length ? one<Quality>(r.quality, ENUM.quality) ?? "low" : "low",
        missingData,
        model: input.meta.model,
        effort: input.meta.effort,
        durationMs: input.meta.durationMs,
      },
      outlook,
      factors,
      events,
      sentiment: {
        professional: observations(sentimentRaw.professional, "sentiment.professional"),
        retail,
        positioning,
        expectations: text(sentimentRaw.expectations, 400),
        limitations: text(sentimentRaw.limitations, 400) || "Sentiment comes only from public pages the web search returned; it is not a measure of the whole market.",
      },
      bullishThesis: thesisOf(r.bullishThesis, "bullishThesis"),
      bearishThesis: thesisOf(r.bearishThesis, "bearishThesis"),
      assessment,
      sources: [...registry.values()],
      summary,
    },
  };
}

/** Importance-weighted cited evidence on each side (hypotheses count half). Pure. */
export function evidenceBalance(factors: Array<Pick<Factor, "impactOnPair" | "importance" | "evidenceType">>) {
  const weight = (factor: Pick<Factor, "importance" | "evidenceType">) =>
    ({ high: 3, medium: 2, low: 1 }[factor.importance] ?? 1) * (factor.evidenceType === "hypothesis" ? 0.5 : 1);
  const bullish = factors.filter((f) => f.impactOnPair === "bullish").reduce((sum, f) => sum + weight(f), 0);
  const bearish = factors.filter((f) => f.impactOnPair === "bearish").reduce((sum, f) => sum + weight(f), 0);
  const strongerSide: "bullish" | "bearish" | "neither" = bullish >= 1.5 * bearish && bullish > 0 ? "bullish" : bearish >= 1.5 * bullish && bearish > 0 ? "bearish" : "neither";
  return { bullish, bearish, strongerSide };
}

/**
 * The model's directional read, held to the evidence: a bullish or bearish
 * lean needs at least one cited factor on that side among its supporting ids,
 * and that side must carry more weight than the other. Otherwise it is
 * "unresolved" (recorded in drops). Never forces a direction.
 */
function assessmentOf(raw: unknown, factors: Factor[], drops: ValidationDrop[]): DirectionalAssessment {
  const a = (raw ?? {}) as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const strings = (value: unknown, max: number, count: number) => list(value).map((item) => (typeof item === "string" ? plainText(item).slice(0, max) : "")).filter(Boolean).slice(0, count);
  const known = new Map(factors.map((factor) => [factor.id, factor]));
  const supportingFactorIds = [...new Set(strings(a.supportingFactorIds, 10, 12).filter((id) => known.has(id)))];
  const balance = evidenceBalance(factors);
  const leans = ["bullish", "bearish", "neutral", "unresolved"];
  const check = (value: unknown, where: string): Lean => {
    const lean = (typeof value === "string" && leans.includes(value) ? value : "unresolved") as Lean;
    if (lean !== "bullish" && lean !== "bearish") return lean;
    const backed = supportingFactorIds.some((id) => known.get(id)?.impactOnPair === lean);
    const heavier = lean === "bullish" ? balance.bullish > balance.bearish : balance.bearish > balance.bullish;
    if (backed && heavier) return lean;
    drops.push({ where, reason: "lean not supported by the cited factors; set to unresolved", value: lean });
    return "unresolved";
  };
  return {
    nearTermLean: check(a.nearTermLean, "assessment.nearTermLean"),
    swingLean: check(a.swingLean, "assessment.swingLean"),
    evidenceBalance: balance,
    drivers: strings(a.drivers, 200, 6),
    strongestOpposing: typeof a.strongestOpposing === "string" ? plainText(a.strongestOpposing).slice(0, 300) : "",
    changeTriggers: strings(a.changeTriggers, 200, 6),
    rationale: typeof a.rationale === "string" ? plainText(a.rationale).slice(0, 600) : "",
    supportingFactorIds,
  };
}
