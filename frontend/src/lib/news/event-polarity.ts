/**
 * How a BEAT (actual above forecast) tends to move the event currency intraday.
 * +1 = higher print is currency-bullish; -1 = higher print is currency-bearish;
 * null = title not mapped or direction is too event-specific (speeches, etc.).
 *
 * Research-only polarity tables informed the keys; this is a display hint for
 * Home, not a trade signal.
 */
const TITLE_POLARITY: Array<{ match: string; polarity: 1 | -1 }> = [
  { match: "non-farm", polarity: 1 },
  { match: "non farm", polarity: 1 },
  { match: "employment change", polarity: 1 },
  { match: "unemployment rate", polarity: -1 },
  { match: "jobless claims", polarity: -1 },
  { match: "adp non", polarity: 1 },
  { match: "jolts", polarity: 1 },
  { match: "cpi", polarity: 1 },
  { match: "inflation", polarity: 1 },
  { match: "pce", polarity: 1 },
  { match: "ppi", polarity: 1 },
  { match: "retail sales", polarity: 1 },
  { match: "durable goods", polarity: 1 },
  { match: "gdp", polarity: 1 },
  { match: "pmi", polarity: 1 },
  { match: "ism manufacturing", polarity: 1 },
  { match: "ism services", polarity: 1 },
  { match: "consumer confidence", polarity: 1 },
  { match: "interest rate", polarity: 1 },
  { match: "cash rate", polarity: 1 },
  { match: "official bank rate", polarity: 1 },
  { match: "policy rate", polarity: 1 },
  { match: "building permits", polarity: 1 },
  { match: "housing starts", polarity: 1 },
  { match: "home sales", polarity: 1 },
  { match: "industrial production", polarity: 1 },
  { match: "manufacturing production", polarity: 1 },
];

const SKIP_TITLE = /speech|speaks|press conference|meeting minutes|bank holiday|holiday|tic long-term|foreign investment/i;

export function eventCurrencyPolarity(title: string): 1 | -1 | null {
  if (SKIP_TITLE.test(title)) return null;
  const lower = title.toLowerCase();
  for (const rule of TITLE_POLARITY) {
    if (lower.includes(rule.match)) return rule.polarity;
  }
  return null;
}
