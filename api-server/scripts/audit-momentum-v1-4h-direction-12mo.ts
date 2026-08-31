/**
 * Frozen 12-month, fixed-horizon direction test of the live Momentum V1 rule.
 * Original, exact inverse, and seeded-random arms share identical raw OANDA
 * bid/ask candles and the same 4-hour midpoint label. No trade rows are read.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { classifyRegime } from "../../frontend/src/lib/strategy/regime.js";
import { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG } from "../../frontend/src/lib/strategy/strategies/momentum.js";
import { dayTradingSession } from "../../frontend/src/lib/strategy/strategy-engine.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";

type Direction = "long" | "short";
type RawBar = { closeTime: string; open: number; high: number; low: number; close: number; bidClose: number; askClose: number };
type Signal = { instrument: string; time: string; direction: Direction; actual: Direction };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const output = path.join(root, "research-v2", "momentum-v1-4h-direction-12mo");
if (!existsSync(output)) mkdirSync(output, { recursive: true });

const PAIRS = ["AUD_JPY", "AUD_USD", "EUR_GBP", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "USD_JPY"];
const WARMUP_START = "2025-06-15T00:00:00.000Z";
const REPLAY_START = "2025-08-01T00:00:00.000Z";
const TRAIN_END = "2026-03-08T00:00:00.000Z";
const DEV_END = "2026-05-20T00:00:00.000Z";
const HOLDOUT_END = "2026-08-01T00:00:00.000Z";
const DATA_END = "2026-08-01T04:15:00.000Z";
const HORIZON_MS = 4 * 3_600_000;
const STEP_MS: Record<"M15" | "H1" | "H4", number> = { M15: 15 * 60_000, H1: 60 * 60_000, H4: 4 * 60 * 60_000 };

async function fetchBars(pair: string, granularity: "M15" | "H1" | "H4") {
  const seen = new Map<string, RawBar>(); let cursor = WARMUP_START;
  for (let page = 0; page < 24; page++) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=${granularity}&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${pair} ${granularity} fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => {
      const midpoint = (key: string) => (+bar.bid[key]! + +bar.ask[key]!) / 2;
      return { closeTime: new Date(Date.parse(bar.time) + STEP_MS[granularity]).toISOString(), open: midpoint("o"), high: midpoint("h"), low: midpoint("l"), close: midpoint("c"), bidClose: +bar.bid.c, askClose: +bar.ask.c };
    });
    for (const bar of pageBars) if (bar.closeTime < DATA_END) seen.set(bar.closeTime, bar);
    if (!pageBars.length || pageBars.length < 5000) break;
    cursor = pageBars.at(-1)!.closeTime;
    if (Date.parse(cursor) >= Date.parse(DATA_END)) break;
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}
function atOrBefore(bars: RawBar[], timestamp: number) {
  let low = 0; let high = bars.length - 1; let found = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (Date.parse(bars[middle]!.closeTime) <= timestamp) { found = middle; low = middle + 1; } else high = middle - 1; }
  return found;
}
function opposite(direction: Direction): Direction { return direction === "long" ? "short" : "long"; }
function randomDirection(pair: string, time: string, seed: number): Direction {
  let hash = 2166136261 ^ seed;
  for (const char of `${pair}|${time}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
  return (hash >>> 0) % 2 === 0 ? "long" : "short";
}
function wilsonLower(hits: number, n: number, z = 1.64) {
  if (!n) return null; const p = hits / n; const denominator = 1 + z * z / n; const centre = p + z * z / (2 * n); const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return (centre - margin) / denominator;
}
function score(signals: Signal[], pick: (signal: Signal) => Direction) {
  const hits = signals.filter((signal) => pick(signal) === signal.actual).length;
  return { n: signals.length, hits, accuracy: signals.length ? hits / signals.length : null, wilsonLower90: wilsonLower(hits, signals.length) };
}

const signals: Signal[] = [];
for (const pair of PAIRS) {
  console.log(`[momentum-4h] fetching ${pair}`);
  const [m15, h1, h4] = await Promise.all([fetchBars(pair, "M15"), fetchBars(pair, "H1"), fetchBars(pair, "H4")]);
  let lockedUntil = Number.NEGATIVE_INFINITY;
  for (let index = 210; index < m15.length; index++) {
    const bar = m15[index]!; const timeMs = Date.parse(bar.closeTime);
    if (bar.closeTime < REPLAY_START || bar.closeTime >= HOLDOUT_END || timeMs < lockedUntil) continue;
    const endIndex = atOrBefore(m15, timeMs + HORIZON_MS);
    if (endIndex < 0 || Date.parse(m15[endIndex]!.closeTime) < timeMs + HORIZON_MS - 30 * 60_000) continue;
    const h1Index = atOrBefore(h1, timeMs); const h4Index = atOrBefore(h4, timeMs);
    if (h1Index < 210 || h4Index < 210) continue;
    const spreadPips = (bar.askClose - bar.bidClose) / pipSizeFor(pair as never);
    const input = {
      instrument: pair as never, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const,
      candles15m: m15.slice(index - 209, index + 1).map((item) => ({ time: item.closeTime, open: item.open, high: item.high, low: item.low, close: item.close, volume: 0, complete: true })),
      candles1h: h1.slice(h1Index - 209, h1Index + 1).map((item) => ({ time: item.closeTime, open: item.open, high: item.high, low: item.low, close: item.close, volume: 0, complete: true })),
      candles4h: h4.slice(h4Index - 209, h4Index + 1).map((item) => ({ time: item.closeTime, open: item.open, high: item.high, low: item.low, close: item.close, volume: 0, complete: true })),
      bid: bar.bidClose, ask: bar.askClose, spreadPips, marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false, evaluatedAt: bar.closeTime, evaluationMode: "historical_replay" as const,
    };
    if (!dayTradingSession(new Date(timeMs)).open) continue;
    const regime = classifyRegime(pair as never, input.candles15m, bar.closeTime);
    const decision = evaluateMomentum(input, regime, DEFAULT_MOMENTUM_CONFIG);
    if (decision.status !== "valid" || !decision.direction) continue;
    const actual: Direction = m15[endIndex]!.close > bar.close ? "long" : "short";
    if (m15[endIndex]!.close === bar.close) continue;
    signals.push({ instrument: pair, time: bar.closeTime, direction: decision.direction, actual });
    lockedUntil = timeMs + HORIZON_MS;
  }
  console.log(`[momentum-4h] ${pair}: ${signals.filter((signal) => signal.instrument === pair).length} non-overlapping signals`);
}

const train = signals.filter((signal) => Date.parse(signal.time) < Date.parse(TRAIN_END));
const development = signals.filter((signal) => Date.parse(signal.time) >= Date.parse(TRAIN_END) && Date.parse(signal.time) < Date.parse(DEV_END));
const holdout = signals.filter((signal) => Date.parse(signal.time) >= Date.parse(DEV_END));
const randomScores = Array.from({ length: 100 }, (_, seed) => score(development, (signal) => randomDirection(signal.instrument, signal.time, seed + 1))).sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0));
const devOriginal = score(development, (signal) => signal.direction);
const devInverse = score(development, (signal) => opposite(signal.direction));
const nominatedArm: "original" | "inverse" | null = devOriginal.n >= 100 && devOriginal.accuracy !== null && devOriginal.accuracy >= 0.5556 && (devOriginal.wilsonLower90 ?? 0) > 0.5
  ? "original"
  : devInverse.n >= 100 && devInverse.accuracy !== null && devInverse.accuracy >= 0.5556 && (devInverse.wilsonLower90 ?? 0) > 0.5 ? "inverse" : null;
const scoreArms = (rows: Signal[]) => ({ original: score(rows, (signal) => signal.direction), inverse: score(rows, (signal) => opposite(signal.direction)) });
const report = {
  generatedAt: new Date().toISOString(),
  scope: { period: "2025-08-01 through 2026-07-31", pairs: PAIRS, detector: "unchanged Momentum V1 with DEFAULT_MOMENTUM_CONFIG", horizon: "four hours, midpoint direction from completed raw OANDA bid/ask M15 bars", execution: "one signal per pair per four-hour window; no stops, targets, P&L, trade rows, or parameter changes" },
  splits: { train: { start: "2025-08-01", endExclusive: "2026-03-08" }, development: { start: "2026-03-08", endExclusive: "2026-05-20", nominationGate: "n >=100; accuracy >=55.56%; 90% Wilson lower bound >50%" }, sealedHoldout: { start: "2026-05-20", endExclusive: "2026-08-01", opened: nominatedArm !== null } },
  signals: { total: signals.length, train: train.length, development: development.length, holdout: holdout.length, byPair: Object.fromEntries(PAIRS.map((pair) => [pair, signals.filter((signal) => signal.instrument === pair).length])) },
  development: { ...scoreArms(development), randomControls: { count: randomScores.length, meanAccuracy: randomScores.reduce((sum, row) => sum + (row.accuracy ?? 0), 0) / randomScores.length, p05Accuracy: randomScores[4]!.accuracy, p95Accuracy: randomScores[94]!.accuracy }, nominatedArm },
  holdout: nominatedArm === null ? { status: "NOT_OPENED_NO_ARM_QUALIFIED" } : { status: "OPENED", nominatedArm, result: nominatedArm === "original" ? score(holdout, (signal) => signal.direction) : score(holdout, (signal) => opposite(signal.direction)), controls: scoreArms(holdout) },
};
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ signals: report.signals, development: report.development, holdout: report.holdout }, null, 2));
