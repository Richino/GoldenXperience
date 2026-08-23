import assert from "node:assert/strict";
import {
  classifyNewsImpact, currenciesForPair, DEFAULT_NEWS_WINDOWS, IMPACT_LEVEL,
  impactLevelName, isCurrencyRelevantToPair, toEpochMs, TRACKED_NEWS_CURRENCIES,
  type NewsEventInput, type NewsWindowConfig,
} from "../src/lib/news/impact-tagging";
import { highImpactMinutesFor } from "../src/lib/macro/rates";

/**
 * News impact tagging. Pure: no database, no network, no clock.
 *
 * Covers the eight cases the feature was specified against, plus the
 * determinism and idempotence properties the backfill depends on.
 */
const event = (over: Partial<NewsEventInput> & Pick<NewsEventInput, "currency" | "timestamp">): NewsEventInput => ({
  id: over.id ?? `${over.currency}:${over.title ?? "Event"}:${String(over.timestamp)}`,
  title: over.title ?? "Event",
  impact: over.impact ?? IMPACT_LEVEL.high,
  currency: over.currency,
  timestamp: over.timestamp,
});

// ============================================================ 1. high impact
{
  const news = event({ currency: "USD", title: "Non-Farm Payrolls", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.high });
  const result = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" }, [news]);
  assert.equal(result.tag, "HIGH_IMPACT_NEWS", "USD high impact + EUR/USD ten minutes later");
  assert.equal(result.currency, "USD");
  assert.equal(result.eventName, "Non-Farm Payrolls");
  assert.equal(result.minutesFromNews, 10, "positive minutes = the trade opened after the release");
  assert.equal(result.impactLevel, IMPACT_LEVEL.high);
  assert.deepEqual(result.matchedEventIds, [news.id]);
}
console.log("1. USD high impact + EUR/USD +10min -> HIGH_IMPACT_NEWS: OK");

// ============================================================ 2. irrelevant currency
{
  const news = event({ currency: "USD", title: "Non-Farm Payrolls", timestamp: "2026-08-24T12:30:00Z" });
  const result = classifyNewsImpact({ pair: "EUR_GBP", entryTime: "2026-08-24T12:40:00Z" }, [news]);
  assert.equal(result.tag, "NO_NEWS", "USD news cannot tag a EUR/GBP trade");
  assert.equal(result.eventId, null);
  assert.deepEqual(result.matchedEventIds, []);
  assert.equal(isCurrencyRelevantToPair("EUR_GBP", "USD"), false);
}
console.log("2. USD news + EUR/GBP -> not relevant: OK");

// ============================================================ 3. GBP -> GBP_USD
{
  const news = event({ currency: "GBP", title: "BoE Rate Decision", timestamp: "2026-08-24T11:00:00Z" });
  const result = classifyNewsImpact({ pair: "GBP_USD", entryTime: "2026-08-24T11:15:00Z" }, [news]);
  assert.equal(result.tag, "HIGH_IMPACT_NEWS");
  assert.equal(result.currency, "GBP");
  assert.equal(isCurrencyRelevantToPair("GBP_USD", "GBP"), true);
  assert.equal(isCurrencyRelevantToPair("EUR_GBP", "GBP"), true, "GBP is also relevant as the quote currency");
}
console.log("3. GBP news + GBP/USD -> relevant: OK");

// ============================================================ 4. JPY -> AUD_JPY
{
  const news = event({ currency: "JPY", title: "BoJ Policy Rate", timestamp: "2026-08-24T03:00:00Z" });
  const result = classifyNewsImpact({ pair: "AUD_JPY", entryTime: "2026-08-24T03:20:00Z" }, [news]);
  assert.equal(result.tag, "HIGH_IMPACT_NEWS", "JPY as the quote currency of a true cross");
  assert.equal(isCurrencyRelevantToPair("AUD_JPY", "JPY"), true);
  assert.equal(isCurrencyRelevantToPair("AUD_JPY", "AUD"), true);
  assert.equal(isCurrencyRelevantToPair("AUD_JPY", "EUR"), false);
}
console.log("4. JPY news + AUD/JPY -> relevant: OK");

// ============================================================ 5. outside the window
{
  const news = event({ currency: "USD", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.high });
  // 91 minutes is past highImpactNearWindowMinutes (90)
  const far = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T14:01:00Z" }, [news]);
  assert.equal(far.tag, "NO_NEWS", "beyond every window");
  // and symmetrically before the release
  const before = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T10:59:00Z" }, [news]);
  assert.equal(before.tag, "NO_NEWS", "the window is symmetric around the release");
  // a medium event just outside the 30-minute near window
  const medium = event({ currency: "USD", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.medium });
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T13:01:00Z" }, [medium]).tag, "NO_NEWS");
  // low impact never matches at all
  const low = event({ currency: "USD", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.low });
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:31:00Z" }, [low]).tag, "NO_NEWS",
    "low impact is below minimumRelevantLevel even one minute away");
}
console.log("5. events outside the configured window -> NO_NEWS: OK");

// ============================================================ 5b. the tag ladder
{
  const high = event({ currency: "USD", title: "CPI", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.high });
  // high impact, inside 30 -> HIGH_IMPACT_NEWS
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:59:00Z" }, [high]).tag, "HIGH_IMPACT_NEWS");
  // high impact, outside 30 but inside 90 -> NEAR_NEWS
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T13:20:00Z" }, [high]).tag, "NEAR_NEWS");
  // medium impact, inside 30 -> NEAR_NEWS
  const medium = event({ currency: "USD", title: "Claims", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.medium });
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:45:00Z" }, [medium]).tag, "NEAR_NEWS");
  // exact boundaries are inclusive
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T13:00:00Z" }, [high]).tag, "HIGH_IMPACT_NEWS", "30 minutes exactly is inside");
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T14:00:00Z" }, [high]).tag, "NEAR_NEWS", "90 minutes exactly is inside");
}
console.log("5b. the full tag ladder incl. inclusive boundaries: OK");

// ============================================================ 6. multiple events
{
  const cpi = event({ id: "usd-cpi", currency: "USD", title: "CPI", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.high });
  const claims = event({ id: "usd-claims", currency: "USD", title: "Jobless Claims", timestamp: "2026-08-24T12:35:00Z", impact: IMPACT_LEVEL.medium });
  const eurPmi = event({ id: "eur-pmi", currency: "EUR", title: "EU PMI", timestamp: "2026-08-24T12:38:00Z", impact: IMPACT_LEVEL.medium });
  const irrelevant = event({ id: "jpy-x", currency: "JPY", title: "JPY thing", timestamp: "2026-08-24T12:36:00Z", impact: IMPACT_LEVEL.high });

  const result = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" }, [claims, eurPmi, cpi, irrelevant]);
  assert.equal(result.tag, "HIGH_IMPACT_NEWS", "the most severe tag any event produces wins");
  assert.equal(result.eventId, "usd-cpi", "attributed to the high-impact event, not the nearer medium one");
  assert.deepEqual(result.matchedEventIds, ["eur-pmi", "usd-claims", "usd-cpi"],
    "all relevant matched events retained and sorted; the JPY event excluded");

  // when impact ties, the closest event wins
  const early = event({ id: "a-early", currency: "USD", title: "A", timestamp: "2026-08-24T12:00:00Z", impact: IMPACT_LEVEL.high });
  const close = event({ id: "b-close", currency: "USD", title: "B", timestamp: "2026-08-24T12:35:00Z", impact: IMPACT_LEVEL.high });
  const tie = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" }, [early, close]);
  assert.equal(tie.eventId, "b-close", "same impact -> nearest to entry");
  assert.equal(tie.minutesFromNews, 5);

  // a NEAR_NEWS trade is never attributed to an out-of-window high-impact event
  const farHigh = event({ id: "far-high", currency: "USD", title: "Far", timestamp: "2026-08-24T09:00:00Z", impact: IMPACT_LEVEL.high });
  const nearMedium = event({ id: "near-med", currency: "USD", title: "Near", timestamp: "2026-08-24T12:35:00Z", impact: IMPACT_LEVEL.medium });
  const near = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" }, [farHigh, nearMedium]);
  assert.equal(near.tag, "NEAR_NEWS");
  assert.equal(near.eventId, "near-med", "attribution comes only from events that achieved the winning tag");
}
console.log("6. multiple events -> correct nearest/highest selected: OK");

// ============================================================ 7. timezone handling
{
  const utc = event({ id: "e", currency: "USD", title: "CPI", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.high });
  const offset = event({ id: "e", currency: "USD", title: "CPI", timestamp: "2026-08-24T08:30:00-04:00", impact: IMPACT_LEVEL.high });
  const asDate = event({ id: "e", currency: "USD", title: "CPI", timestamp: new Date("2026-08-24T12:30:00Z"), impact: IMPACT_LEVEL.high });
  assert.equal(toEpochMs(utc.timestamp), toEpochMs(offset.timestamp), "the same instant in two notations");
  assert.equal(toEpochMs(utc.timestamp), toEpochMs(asDate.timestamp), "Date and string agree");

  // the same trade, expressed three ways, must tag identically
  const a = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" }, [utc]);
  const b = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T08:40:00-04:00" }, [offset]);
  const c = classifyNewsImpact({ pair: "EUR_USD", entryTime: new Date("2026-08-24T12:40:00Z") }, [asDate]);
  assert.deepEqual(a, b, "ET-offset input must equal UTC input");
  assert.deepEqual(a, c, "Date input must equal string input");
  assert.equal(a.eventTime, "2026-08-24T12:30:00.000Z", "the stored event time is normalized to UTC");

  // a DST boundary must not shift the classification
  const winter = classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-01-15T13:40:00Z" },
    [event({ currency: "USD", timestamp: "2026-01-15T13:30:00Z", impact: IMPACT_LEVEL.high })]);
  assert.equal(winter.tag, "HIGH_IMPACT_NEWS");
  assert.equal(winter.minutesFromNews, 10, "offsets are irrelevant once both sides are epochs");

  // unparseable input fails closed rather than guessing
  assert.equal(toEpochMs("not a date"), null);
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "not a date" }, [utc]).tag, "NO_NEWS");
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" },
    [event({ currency: "USD", timestamp: "garbage" })]).tag, "NO_NEWS");
}
console.log("7. timezone handling is instant-based, not string-based: OK");

// ============================================================ 8. deterministic / idempotent
{
  const events = [
    event({ id: "z", currency: "USD", title: "Z", timestamp: "2026-08-24T12:35:00Z", impact: IMPACT_LEVEL.high }),
    event({ id: "a", currency: "USD", title: "A", timestamp: "2026-08-24T12:35:00Z", impact: IMPACT_LEVEL.high }),
    event({ id: "m", currency: "EUR", title: "M", timestamp: "2026-08-24T12:36:00Z", impact: IMPACT_LEVEL.medium }),
  ];
  const trade = { pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" };
  const first = classifyNewsImpact(trade, events);

  // re-running produces an identical record: the backfill is safe to repeat
  for (let run = 0; run < 5; run += 1) {
    assert.deepEqual(classifyNewsImpact(trade, events), first, "repeated runs must be identical");
  }
  // and input ORDER must not change the answer, since the DB may return any order
  assert.deepEqual(classifyNewsImpact(trade, [...events].reverse()), first, "order-independent");
  assert.deepEqual(classifyNewsImpact(trade, [events[2]!, events[0]!, events[1]!]), first, "order-independent");
  // a fully-tied pair resolves by id, so the winner can never alternate
  assert.equal(first.eventId, "a", "identical impact and distance -> lowest event id");
  assert.deepEqual(first.matchedEventIds, ["a", "m", "z"], "matched ids always sorted");
}
console.log("8. deterministic and order-independent -> backfill is idempotent: OK");

// ============================================================ configurability
{
  const wide: NewsWindowConfig = { ...DEFAULT_NEWS_WINDOWS, highImpactWindowMinutes: 60 };
  const news = event({ currency: "USD", timestamp: "2026-08-24T12:30:00Z", impact: IMPACT_LEVEL.high });
  const trade = { pair: "EUR_USD", entryTime: "2026-08-24T13:20:00Z" };
  assert.equal(classifyNewsImpact(trade, [news]).tag, "NEAR_NEWS", "50 minutes is NEAR under the default 30");
  assert.equal(classifyNewsImpact(trade, [news], wide).tag, "HIGH_IMPACT_NEWS", "and HIGH once the window widens to 60");
  const off: NewsWindowConfig = { ...DEFAULT_NEWS_WINDOWS, highImpactWindowMinutes: 0, nearWindowMinutes: 0, highImpactNearWindowMinutes: 0 };
  assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:31:00Z" }, [news], off).tag, "NO_NEWS");
}
console.log("windows are configurable, not hard-coded: OK");

// ============================================================ currency coverage
{
  for (const currency of TRACKED_NEWS_CURRENCIES) {
    assert.equal(typeof currency, "string");
  }
  // every currency in the traded catalog is representable
  assert.deepEqual(currenciesForPair("EUR_USD"), ["EUR", "USD"]);
  assert.deepEqual(currenciesForPair("EUR/USD"), ["EUR", "USD"], "display form accepted too");
  assert.deepEqual(currenciesForPair("AUD_JPY"), ["AUD", "JPY"]);
  for (const [pair, currency] of [
    ["EUR_USD", "USD"], ["GBP_USD", "USD"], ["USD_JPY", "USD"], ["USD_CAD", "USD"],
    ["USD_CHF", "USD"], ["AUD_USD", "USD"], ["GBP_USD", "GBP"], ["EUR_GBP", "GBP"],
    ["EUR_USD", "EUR"], ["EUR_GBP", "EUR"], ["AUD_USD", "AUD"], ["AUD_JPY", "AUD"],
    ["USD_JPY", "JPY"], ["AUD_JPY", "JPY"], ["USD_CAD", "CAD"], ["USD_CHF", "CHF"],
    ["NZD_USD", "NZD"],
  ] as const) {
    assert.equal(isCurrencyRelevantToPair(pair, currency), true, `${currency} must be relevant to ${pair}`);
  }
  for (const [pair, currency] of [
    ["EUR_GBP", "USD"], ["EUR_USD", "JPY"], ["AUD_JPY", "USD"], ["USD_CHF", "CAD"],
  ] as const) {
    assert.equal(isCurrencyRelevantToPair(pair, currency), false, `${currency} must NOT be relevant to ${pair}`);
  }
  assert.equal(isCurrencyRelevantToPair("EUR_USD", "usd"), true, "case-insensitive");
  assert.equal(isCurrencyRelevantToPair("", "USD"), false);
  assert.equal(isCurrencyRelevantToPair("EUR_USD", ""), false);
}
console.log("pair<->currency relevance matrix: OK");

assert.equal(impactLevelName(IMPACT_LEVEL.high), "high");
assert.equal(impactLevelName(IMPACT_LEVEL.medium), "medium");
assert.equal(impactLevelName(null), "none");

// an empty calendar is NO_NEWS, never an error
assert.equal(classifyNewsImpact({ pair: "EUR_USD", entryTime: "2026-08-24T12:40:00Z" }, []).tag, "NO_NEWS");

console.log("\nAll news impact tagging assertions passed.");

// ============================================================ execution neutrality
// The calendar normalizer was widened to every traded currency so the TAGGER
// can see AUD/CAD/CHF/NZD releases. That widening must not reach the pre-trade
// news gate, which would otherwise start blocking entries that are taken today.
{
  const now = new Date("2026-08-24T12:00:00Z");
  const audPrint = [{ currency: "AUD", impact: IMPACT_LEVEL.high, timestamp: "2026-08-24T12:10:00Z" }];

  assert.equal(highImpactMinutesFor("AUD_USD", audPrint, now), null,
    "an AUD release must remain invisible to the news gate — widening it would change which trades happen");
  for (const [pair, currency] of [["USD_CAD", "CAD"], ["USD_CHF", "CHF"], ["NZD_USD", "NZD"]] as const) {
    assert.equal(
      highImpactMinutesFor(pair, [{ currency, impact: IMPACT_LEVEL.high, timestamp: "2026-08-24T12:10:00Z" }], now),
      null, `${currency} must not newly gate ${pair}`);
  }
  // the four currencies the gate has always seen still gate exactly as before
  assert.equal(highImpactMinutesFor("EUR_USD",
    [{ currency: "USD", impact: IMPACT_LEVEL.high, timestamp: "2026-08-24T12:10:00Z" }], now), 10,
    "USD must still gate EUR_USD");
  assert.equal(highImpactMinutesFor("EUR_GBP",
    [{ currency: "GBP", impact: IMPACT_LEVEL.high, timestamp: "2026-08-24T12:25:00Z" }], now), 25);
  // and the same AUD release IS visible to the tagger
  assert.equal(classifyNewsImpact({ pair: "AUD_USD", entryTime: "2026-08-24T12:20:00Z" },
    [event({ currency: "AUD", timestamp: "2026-08-24T12:10:00Z", impact: IMPACT_LEVEL.high })]).tag,
    "HIGH_IMPACT_NEWS", "the tagger sees what the gate deliberately does not");
}
console.log("execution neutrality: widened calendar cannot reach the pre-trade gate: OK");
