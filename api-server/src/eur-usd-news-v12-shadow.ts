export type EurUsdNewsV12Direction = 1 | -1;

export type EurUsdNewsV12Event = {
  releaseTimeUtc: string;
  currency: "EUR" | "USD";
  eventName: string;
  actual: string;
  forecast: string;
};

export type EurUsdNewsV12Group = {
  releaseTimeUtc: string;
  direction: EurUsdNewsV12Direction;
  surpriseStrength: number;
  events: EurUsdNewsV12Event[];
};

/**
 * Frozen after the Aug 2024-Jul 2025 development and Aug 2025-Jul 2026
 * validation replay. This policy is observation-only and cannot place orders.
 */
export const EUR_USD_NEWS_V12_SHADOW_POLICY = Object.freeze({
  version: "eurusd-news-v12-shadow-1" as const,
  instrument: "EUR_USD" as const,
  status: "SHADOW_ONLY" as const,
  ordersAllowed: false as const,
  forwardSampleStartsAt: "2026-08-01T00:00:00.000Z",
  confirmationMinutes: 15,
  surpriseStrengthThreshold: 0.06766917293233082,
  lowVolatilityAtrCeilingPips: 5.53,
  stopAtr: 1,
  targetToStop: 2,
  winPayoffR: 1.5,
  lossPayoffR: -0.75,
  maximumHoldingHours: 72,
  minimumResolvedTrades: 60,
  minimumWinRate: 0.4,
  minimumProfitFactor: 1,
});

export const EUR_USD_NEWS_V13_CHALLENGER_POLICY = Object.freeze({
  version: "eurusd-news-v13-spread-gate-shadow-1" as const,
  instrument: "EUR_USD" as const,
  status: "SHADOW_ONLY" as const,
  ordersAllowed: false as const,
  forwardSampleStartsAt: "2026-09-01T00:00:00.000Z",
  baseVersion: EUR_USD_NEWS_V12_SHADOW_POLICY.version,
  maximumSpreadToStopRatio: 0.5,
  minimumResolvedTrades: 60,
  minimumWinRate: 0.4,
  minimumProfitFactor: 1,
});

export function parseEurUsdNewsV12Number(value: string) {
  const match = value.trim().replace(/,/g, "").match(/^(-?\d+(?:\.\d+)?)\s*([KMB%])?$/i);
  if (!match) return null;
  return { value: Number(match[1]), unit: (match[2] ?? "").toUpperCase() };
}

export function classifyEurUsdNewsV12Event(event: EurUsdNewsV12Event): {
  direction: EurUsdNewsV12Direction;
  magnitude: number;
} | null {
  const actual = parseEurUsdNewsV12Number(event.actual);
  const forecast = parseEurUsdNewsV12Number(event.forecast);
  if (!actual || !forecast || actual.unit !== forecast.unit || actual.value === forecast.value) return null;

  const laborInverse = /Unemployment (Rate|Claims)/.test(event.eventName);
  if (/(CPI|PPI|PCE|Federal Funds Rate|Main Refinancing Rate)/.test(event.eventName)) return null;
  if (!laborInverse && !/(Employment Change|Hourly Earnings|GDP|PMI|Job Openings|Retail Sales|Employment Cost|Consumer Sentiment)/.test(event.eventName)) return null;

  const currencyGood = (actual.value > forecast.value ? 1 : -1) * (laborInverse ? -1 : 1);
  const direction = (currencyGood * (event.currency === "EUR" ? 1 : -1)) as EurUsdNewsV12Direction;
  const magnitude = Math.abs(actual.value - forecast.value) / Math.max(Math.abs(forecast.value), 1);
  return { direction, magnitude };
}

export function groupEurUsdNewsV12Events(events: EurUsdNewsV12Event[]) {
  const byTime = new Map<string, Array<{
    event: EurUsdNewsV12Event;
    direction: EurUsdNewsV12Direction;
    magnitude: number;
  }>>();

  for (const event of events) {
    const signal = classifyEurUsdNewsV12Event(event);
    if (!signal) continue;
    const releaseTimeUtc = new Date(event.releaseTimeUtc).toISOString();
    byTime.set(releaseTimeUtc, [...(byTime.get(releaseTimeUtc) ?? []), { event, ...signal }]);
  }

  return [...byTime.entries()]
    .flatMap(([releaseTimeUtc, signals]): EurUsdNewsV12Group[] => {
      const vote = signals.reduce((sum, signal) => sum + signal.direction, 0);
      if (vote === 0) return [];
      return [{
        releaseTimeUtc,
        direction: vote > 0 ? 1 : -1,
        surpriseStrength: signals.reduce((sum, signal) => sum + signal.magnitude, 0),
        events: signals.map((signal) => signal.event),
      }];
    })
    .sort((left, right) => Date.parse(left.releaseTimeUtc) - Date.parse(right.releaseTimeUtc));
}

export function passesEurUsdNewsV12FrozenFilters(input: {
  group: EurUsdNewsV12Group;
  preReleaseAtr: number;
  preReleaseMid: number;
  confirmationCloseMid: number;
}) {
  if (input.group.surpriseStrength < EUR_USD_NEWS_V12_SHADOW_POLICY.surpriseStrengthThreshold) return false;
  if (!Number.isFinite(input.preReleaseAtr) || input.preReleaseAtr <= 0) return false;
  if (input.preReleaseAtr * 10_000 > EUR_USD_NEWS_V12_SHADOW_POLICY.lowVolatilityAtrCeilingPips) return false;
  return input.group.direction === 1
    ? input.confirmationCloseMid > input.preReleaseMid
    : input.confirmationCloseMid < input.preReleaseMid;
}

export function createEurUsdNewsV12Levels(input: {
  direction: EurUsdNewsV12Direction;
  executableEntry: number;
  preReleaseAtr: number;
}) {
  if (!Number.isFinite(input.executableEntry) || input.executableEntry <= 0) throw new Error("Executable entry must be positive.");
  if (!Number.isFinite(input.preReleaseAtr) || input.preReleaseAtr <= 0) throw new Error("Pre-release ATR must be positive.");
  const risk = EUR_USD_NEWS_V12_SHADOW_POLICY.stopAtr * input.preReleaseAtr;
  return input.direction === 1
    ? { risk, stop: input.executableEntry - risk, target: input.executableEntry + EUR_USD_NEWS_V12_SHADOW_POLICY.targetToStop * risk }
    : { risk, stop: input.executableEntry + risk, target: input.executableEntry - EUR_USD_NEWS_V12_SHADOW_POLICY.targetToStop * risk };
}

export function resolveEurUsdNewsV12FirstTouch(input: {
  direction: EurUsdNewsV12Direction;
  stop: number;
  target: number;
  bars: Array<{ time: string; bid: { h: number; l: number }; ask: { h: number; l: number } }>;
}) {
  for (const bar of input.bars) {
    const targetHit = input.direction === 1 ? bar.bid.h >= input.target : bar.ask.l <= input.target;
    const stopHit = input.direction === 1 ? bar.bid.l <= input.stop : bar.ask.h >= input.stop;
    if (targetHit && stopHit) return { result: "STILL_AMBIGUOUS" as const, time: bar.time };
    if (targetHit) return { result: "TARGET_FIRST" as const, time: bar.time };
    if (stopHit) return { result: "STOP_FIRST" as const, time: bar.time };
  }
  return { result: "NO_TOUCH" as const, time: null };
}
