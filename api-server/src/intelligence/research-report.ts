/**
 * Market intelligence report: the JSON schema the model must answer in, and
 * the validator every answer goes through before anything is stored or shown.
 *
 * The validator is the guard against invented sources: a cited URL must be
 * one the web search actually returned in this run. Items whose citations do
 * not survive are dropped and recorded (never shown as evidence). News items
 * are de-duplicated by event, so several outlets repeating one story count
 * once. Labels are qualitative; there are no numeric confidence scores.
 */

export type Direction = "BULLISH" | "BEARISH" | "MIXED" | "UNCLEAR";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type Implication = "SUPPORTS_BUY" | "SUPPORTS_SELL" | "MIXED" | "UNCLEAR";

export type NewsItem = {
  headline: string;
  publisher: string;
  publishedAt: string | null;
  url: string;
  currencies: string[];
  topic: string;
  kind: "FACT" | "ANALYSIS";
  implication: Implication;
  summary: string;
};

export type SentimentObservation = {
  source: string;
  url: string;
  stance: "POSITIONING" | "BULLISH_CALL" | "BEARISH_CALL" | "NEUTRAL" | "SPECULATION";
  text: string;
};

export type EvidencePoint = { point: string; urls: string[] };

export type IntelligenceReport = {
  overallBias: Direction;
  confidence: Confidence;
  summary: string;
  baseCurrency: { label: string; summary: string };
  quoteCurrency: { label: string; summary: string };
  ratesAndYields: string;
  riskSentiment: string;
  technicalVsFundamental: string;
  news: NewsItem[];
  sentiment: { summary: string; observations: SentimentObservation[]; limitations: string };
  bullishEvidence: EvidencePoint[];
  bearishEvidence: EvidencePoint[];
  catalysts: Array<{ event: string; why: string }>;
  uncertainties: string[];
  conclusion: { supports: string; invalidatedBy: string; needsPriceConfirmation: string };
};

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const evidence = { type: "array", items: { type: "object", additionalProperties: false, required: ["point", "urls"], properties: { point: str, urls: strArr } } } as const;
const outlook = { type: "object", additionalProperties: false, required: ["label", "summary"], properties: { label: str, summary: str } } as const;

/** Strict JSON schema for the Responses API (all fields required; nullable where noted). */
export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overallBias", "confidence", "summary", "baseCurrency", "quoteCurrency", "ratesAndYields", "riskSentiment", "technicalVsFundamental", "news", "sentiment", "bullishEvidence", "bearishEvidence", "catalysts", "uncertainties", "conclusion"],
  properties: {
    overallBias: { type: "string", enum: ["BULLISH", "BEARISH", "MIXED", "UNCLEAR"] },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    summary: str,
    baseCurrency: outlook,
    quoteCurrency: outlook,
    ratesAndYields: str,
    riskSentiment: str,
    technicalVsFundamental: str,
    news: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "publisher", "publishedAt", "url", "currencies", "topic", "kind", "implication", "summary"],
        properties: {
          headline: str, publisher: str, publishedAt: { type: ["string", "null"] }, url: str, currencies: strArr, topic: str,
          kind: { type: "string", enum: ["FACT", "ANALYSIS"] },
          implication: { type: "string", enum: ["SUPPORTS_BUY", "SUPPORTS_SELL", "MIXED", "UNCLEAR"] },
          summary: str,
        },
      },
    },
    sentiment: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "observations", "limitations"],
      properties: {
        summary: str,
        limitations: str,
        observations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "url", "stance", "text"],
            properties: { source: str, url: str, text: str, stance: { type: "string", enum: ["POSITIONING", "BULLISH_CALL", "BEARISH_CALL", "NEUTRAL", "SPECULATION"] } },
          },
        },
      },
    },
    bullishEvidence: evidence,
    bearishEvidence: evidence,
    catalysts: { type: "array", items: { type: "object", additionalProperties: false, required: ["event", "why"], properties: { event: str, why: str } } },
    uncertainties: strArr,
    conclusion: {
      type: "object",
      additionalProperties: false,
      required: ["supports", "invalidatedBy", "needsPriceConfirmation"],
      properties: { supports: str, invalidatedBy: str, needsPriceConfirmation: str },
    },
  },
} as const;

/** Canonical form of a URL for matching citations (no hash, no tracking params, no trailing slash). */
export function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^ref$|^src$/i.test(key)) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return `${url.hostname}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

const ENUMS = {
  bias: ["BULLISH", "BEARISH", "MIXED", "UNCLEAR"],
  confidence: ["LOW", "MEDIUM", "HIGH"],
  kind: ["FACT", "ANALYSIS"],
  implication: ["SUPPORTS_BUY", "SUPPORTS_SELL", "MIXED", "UNCLEAR"],
  stance: ["POSITIONING", "BULLISH_CALL", "BEARISH_CALL", "NEUTRAL", "SPECULATION"],
};

/**
 * Plain text for display. Some models inline markdown citations such as
 * "([reuters.com](https://…))"; the sources are shown as links already, so
 * those are removed (a bare [label](url) keeps its label).
 */
export function plainText(value: string) {
  return value
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}
const text = (value: unknown, max = 600) => (typeof value === "string" ? plainText(value).slice(0, max) : "");
const oneOf = <T extends string>(value: unknown, allowed: string[], fallback: T): T => (typeof value === "string" && allowed.includes(value) ? value as T : fallback);

const STOP_WORDS = new Set(["says", "said", "after", "amid", "with", "from", "that", "this", "will", "into", "over", "the", "and", "for"]);
const wordsOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));

/**
 * Two reports of the same event: same topic (the model names one per item),
 * same currencies, same day — outlet phrasing of the headline is ignored.
 * A topic too thin to identify an event falls back to the headline's words.
 */
function eventKey(item: { topic: string; headline: string; currencies: string[]; publishedAt: string | null }) {
  const topic = [...new Set(wordsOf(item.topic))].sort();
  const words = topic.length >= 2 ? topic : [...new Set(wordsOf(item.headline))].sort().slice(0, 6);
  return `${[...item.currencies].sort().join("/")}|${item.publishedAt?.slice(0, 10) ?? "undated"}|${words.join(" ")}`;
}

export type ValidationResult =
  | { ok: true; report: IntelligenceReport; dropped: Array<{ where: string; reason: string; value: unknown }> }
  | { ok: false; reason: string };

/**
 * Validate a model answer against the URLs the search returned. Keeps only
 * cited items whose URLs are real results; drops (and records) the rest.
 */
export function validateReport(raw: unknown, allowedUrls: Iterable<string>, currencies: string[]): ValidationResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "The answer was not an object." };
  const r = raw as Record<string, unknown>;
  const allowed = new Set([...allowedUrls].map(canonicalUrl).filter((url): url is string => url !== null));
  const dropped: Array<{ where: string; reason: string; value: unknown }> = [];
  const known = (url: unknown) => typeof url === "string" && allowed.has(canonicalUrl(url) ?? "");

  const news: NewsItem[] = [];
  const seenEvents = new Map<string, NewsItem>();
  for (const item of Array.isArray(r.news) ? r.news : []) {
    const n = item as Record<string, unknown>;
    if (!known(n.url)) { dropped.push({ where: "news", reason: "URL was not returned by the web search", value: n.url }); continue; }
    const candidate: NewsItem = {
      headline: text(n.headline, 240),
      publisher: text(n.publisher, 80),
      publishedAt: typeof n.publishedAt === "string" && Number.isFinite(Date.parse(n.publishedAt)) ? new Date(Date.parse(n.publishedAt)).toISOString() : null,
      url: String(n.url),
      currencies: (Array.isArray(n.currencies) ? n.currencies : []).filter((c): c is string => typeof c === "string" && currencies.includes(c.toUpperCase())).map((c) => c.toUpperCase()),
      topic: text(n.topic, 120),
      kind: oneOf(n.kind, ENUMS.kind, "ANALYSIS"),
      implication: oneOf(n.implication, ENUMS.implication, "UNCLEAR"),
      summary: text(n.summary, 500),
    };
    if (!candidate.headline || !candidate.summary) { dropped.push({ where: "news", reason: "missing headline or summary", value: n.url }); continue; }
    // One event reported by several outlets counts once: keep the first factual report.
    const key = eventKey(candidate);
    const existing = seenEvents.get(key);
    if (existing) {
      let loser = candidate;
      if (existing.kind === "ANALYSIS" && candidate.kind === "FACT") {
        news[news.indexOf(existing)] = candidate;
        seenEvents.set(key, candidate);
        loser = existing;
      }
      dropped.push({ where: "news", reason: "duplicate report of the same event", value: loser.url });
      continue;
    }
    seenEvents.set(key, candidate);
    news.push(candidate);
  }

  const evidenceOf = (value: unknown, where: string): EvidencePoint[] => (Array.isArray(value) ? value : []).flatMap((item) => {
    const e = item as Record<string, unknown>;
    const urls = (Array.isArray(e.urls) ? e.urls : []).filter(known).map(String);
    if (!urls.length) { dropped.push({ where, reason: "no citation returned by the web search", value: e.point }); return []; }
    const point = text(e.point, 400);
    return point ? [{ point, urls: [...new Set(urls)] }] : [];
  });

  const sentimentRaw = (r.sentiment ?? {}) as Record<string, unknown>;
  const observations = (Array.isArray(sentimentRaw.observations) ? sentimentRaw.observations : []).flatMap((item) => {
    const o = item as Record<string, unknown>;
    if (!known(o.url)) { dropped.push({ where: "sentiment", reason: "URL was not returned by the web search", value: o.url }); return []; }
    return [{ source: text(o.source, 80), url: String(o.url), stance: oneOf(o.stance, ENUMS.stance, "SPECULATION"), text: text(o.text, 400) }];
  });
  const outlookOf = (value: unknown) => {
    const o = (value ?? {}) as Record<string, unknown>;
    return { label: text(o.label, 60) || "Unclear", summary: text(o.summary, 500) };
  };
  const conclusion = (r.conclusion ?? {}) as Record<string, unknown>;

  const report: IntelligenceReport = {
    overallBias: oneOf(r.overallBias, ENUMS.bias, "UNCLEAR"),
    confidence: oneOf(r.confidence, ENUMS.confidence, "LOW"),
    summary: text(r.summary, 800),
    baseCurrency: outlookOf(r.baseCurrency),
    quoteCurrency: outlookOf(r.quoteCurrency),
    ratesAndYields: text(r.ratesAndYields, 600),
    riskSentiment: text(r.riskSentiment, 400),
    technicalVsFundamental: text(r.technicalVsFundamental, 500),
    news: news.slice(0, 12),
    sentiment: {
      summary: text(sentimentRaw.summary, 500),
      observations: observations.slice(0, 8),
      limitations: text(sentimentRaw.limitations, 400) || "Community sentiment comes only from public pages the web search returned; it is not a measure of the whole market.",
    },
    bullishEvidence: evidenceOf(r.bullishEvidence, "bullishEvidence").slice(0, 8),
    bearishEvidence: evidenceOf(r.bearishEvidence, "bearishEvidence").slice(0, 8),
    catalysts: (Array.isArray(r.catalysts) ? r.catalysts : []).map((c) => ({ event: text((c as Record<string, unknown>).event, 160), why: text((c as Record<string, unknown>).why, 300) })).filter((c) => c.event).slice(0, 8),
    uncertainties: (Array.isArray(r.uncertainties) ? r.uncertainties : []).map((u) => text(u, 300)).filter(Boolean).slice(0, 8),
    conclusion: {
      supports: text(conclusion.supports, 500),
      invalidatedBy: text(conclusion.invalidatedBy, 500),
      needsPriceConfirmation: text(conclusion.needsPriceConfirmation, 500),
    },
  };
  if (!report.summary) return { ok: false, reason: "The answer had no summary." };
  // With no surviving evidence at all, a directional bias is unsupported.
  if (!report.bullishEvidence.length && !report.bearishEvidence.length && !report.news.length) {
    report.overallBias = "UNCLEAR";
    report.confidence = "LOW";
  }
  return { ok: true, report, dropped };
}
