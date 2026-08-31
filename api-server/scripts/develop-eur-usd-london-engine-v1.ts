/**
 * EUR/USD-only London breakout engine, research stage.
 *
 * A single predeclared rule is evaluated on raw OANDA bid/ask M15 candles.
 * It never reads trade records, writes database data, or opens an order.
 * Holdout candles are fetched only when the development gate passes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { labelOutcome } from "../src/research.js";

type Direction = "long" | "short";
type Candle = { closeTime: string; open: number; high: number; low: number; close: number; bidOpen: number; bidClose: number; bidHigh: number; bidLow: number; askOpen: number; askClose: number; askHigh: number; askLow: number };
type Candidate = { index: number; decisionTime: string; signalDirection: Direction; riskDistance: number; targetDistance: number };
type ArmResult = { n: number; wins: number; totalR: number; expectancyR: number; winRate: number; ci95: [number, number] };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const pair = "EUR_USD"; const warmupStart = "2025-07-20T00:00:00.000Z"; const developmentStart = "2025-08-01T00:00:00.000Z"; const developmentEnd = "2026-04-01T00:00:00.000Z"; const holdoutEnd = "2026-08-01T00:00:00.000Z";
const mode: "breakout" | "fade" | "pullback" = process.env.EUR_USD_LONDON_MODE === "fade" ? "fade" : process.env.EUR_USD_LONDON_MODE === "pullback" ? "pullback" : "breakout";
const engineName = mode === "fade" ? "EUR/USD London false-break v1" : mode === "pullback" ? "EUR/USD London pullback continuation v1" : "EUR/USD London breakout v1";
const output = path.join(root, "research-v2", mode === "fade" ? "eur-usd-london-fade-v1" : mode === "pullback" ? "eur-usd-london-pullback-v1" : "eur-usd-london-engine-v1"); if (!existsSync(output)) mkdirSync(output, { recursive: true });
const LONDON = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function londonClock(iso: string) {
  const parts = LONDON.formatToParts(new Date(iso)); const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? "00";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}
function atr(bars: Candle[], period = 14) {
  const values = new Array<number>(bars.length).fill(Number.NaN); let smoothed = 0;
  for (let index = 0; index < bars.length; index++) { const bar = bars[index]!; const prior = bars[index - 1]; const range = prior ? Math.max(bar.high - bar.low, Math.abs(bar.high - prior.close), Math.abs(bar.low - prior.close)) : bar.high - bar.low; if (index < period) { smoothed += range; if (index === period - 1) values[index] = smoothed / period; } else { smoothed = ((values[index - 1] as number) * (period - 1) + range) / period; values[index] = smoothed; } }
  return values;
}
function opposite(direction: Direction): Direction { return direction === "long" ? "short" : "long"; }
function randomDirection(time: string, seed: number): Direction { let hash = 2166136261 ^ seed; for (const character of `${pair}|${time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return (hash >>> 0) % 2 === 0 ? "long" : "short"; }
function ci95(results: number[]): [number, number] { if (results.length < 2) return [0, 0]; const mean = results.reduce((sum, value) => sum + value, 0) / results.length; const variance = results.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (results.length - 1); const delta = 1.96 * Math.sqrt(variance / results.length); return [mean - delta, mean + delta]; }

async function fetchM15(endExclusive: string) {
  const bars = new Map<string, Candle>(); let cursor = warmupStart;
  for (let page = 0; page < 20; page++) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=M15&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`EUR_USD M15 fetch failed: ${response.status}`);
    const json = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (json.candles ?? []).filter((bar) => bar.complete).map((bar) => { const mid = (key: string) => (+bar.bid[key]! + +bar.ask[key]!) / 2; return { closeTime: new Date(Date.parse(bar.time) + 15 * 60_000).toISOString(), open: mid("o"), high: mid("h"), low: mid("l"), close: mid("c"), bidOpen: +bar.bid.o, bidClose: +bar.bid.c, bidHigh: +bar.bid.h, bidLow: +bar.bid.l, askOpen: +bar.ask.o, askClose: +bar.ask.c, askHigh: +bar.ask.h, askLow: +bar.ask.l }; });
    for (const bar of pageBars) if (bar.closeTime < endExclusive) bars.set(bar.closeTime, bar);
    if (!pageBars.length || pageBars.length < 5000) break; cursor = pageBars.at(-1)!.closeTime; if (Date.parse(cursor) >= Date.parse(endExclusive)) break;
  }
  return [...bars.values()].sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
}

function candidatesFor(bars: Candle[], from: string, to: string) {
  const values = atr(bars); const candidates: Candidate[] = []; const usedSessions = new Set<string>(); const diagnostics = { eightAmBars: 0, insufficientAsia: 0, rangeRejected: 0, noBreakout: 0, riskRejected: 0 };
  for (let index = 32; index < bars.length - 1; index++) {
    const current = bars[index]!; if (current.closeTime < from || current.closeTime >= to) continue;
    const clock = londonClock(current.closeTime); if (clock.minutes !== 8 * 60 || usedSessions.has(clock.date)) continue; diagnostics.eightAmBars++;
    const asia = bars.slice(Math.max(0, index - 36), index).filter((bar) => { const time = londonClock(bar.closeTime); return time.date === clock.date && time.minutes >= 0 && time.minutes < 7 * 60; });
    const currentAtr = values[index]!; if (asia.length < 24 || !Number.isFinite(currentAtr) || currentAtr <= 0) { diagnostics.insufficientAsia++; continue; }
    const asiaHigh = Math.max(...asia.map((bar) => bar.high)); const asiaLow = Math.min(...asia.map((bar) => bar.low));
    // A seven-hour range spans 28 M15 candles. Normalize it to the expected
    // multi-candle move rather than incorrectly comparing it to one M15 ATR.
    const sessionVolatility = Math.sqrt(28) * currentAtr; const rangeAtr = (asiaHigh - asiaLow) / sessionVolatility;
    // Predeclared EUR/USD rule: a normally sized Asian range, then the first
    // 08:00 London close outside it. No intraday parameter search is performed.
    if (rangeAtr < 0.35 || rangeAtr > 1.2) { diagnostics.rangeRejected++; continue; }
    let direction: Direction | null = null; let trigger = current; let triggerIndex = index; let stop = 0;
    if (mode === "pullback") {
      let breakDirection: Direction | null = null; let retest: Candle | null = null;
      for (let scan = index; scan < bars.length; scan++) {
        const bar = bars[scan]!; const time = londonClock(bar.closeTime); if (time.date !== clock.date || time.minutes >= 11 * 60) break;
        if (!breakDirection) { breakDirection = bar.close > asiaHigh ? "long" : bar.close < asiaLow ? "short" : null; continue; }
        if (!retest) {
          const touchedBoundary = breakDirection === "long" ? bar.low <= asiaHigh && bar.close >= asiaHigh : bar.high >= asiaLow && bar.close <= asiaLow;
          if (touchedBoundary) retest = bar;
          continue;
        }
        const resumed = breakDirection === "long" ? bar.close > retest.high : bar.close < retest.low;
        if (resumed) { direction = breakDirection; trigger = bar; triggerIndex = scan; const triggerAtr = values[scan]!; stop = direction === "long" ? retest.low - 0.1 * triggerAtr : retest.high + 0.1 * triggerAtr; break; }
      }
    } else {
      direction = mode === "breakout"
        ? current.close > asiaHigh ? "long" : current.close < asiaLow ? "short" : null
        : current.high > asiaHigh && current.close < asiaHigh ? "short" : current.low < asiaLow && current.close > asiaLow ? "long" : null;
      stop = mode === "breakout"
        ? direction === "long" ? asiaLow - 0.1 * currentAtr : asiaHigh + 0.1 * currentAtr
        : direction === "long" ? current.low - 0.1 * currentAtr : current.high + 0.1 * currentAtr;
    }
    if (!direction) { diagnostics.noBreakout++; continue; }
    const entry = direction === "long" ? trigger.askClose : trigger.bidClose;
    const riskDistance = Math.abs(entry - stop);
    const riskVolatility = mode === "pullback" ? values[triggerIndex]! : sessionVolatility;
    if (riskDistance < 0.4 * riskVolatility || riskDistance > 2.5 * riskVolatility) { diagnostics.riskRejected++; continue; }
    candidates.push({ index: triggerIndex, decisionTime: trigger.closeTime, signalDirection: direction, riskDistance, targetDistance: 1.5 * riskDistance }); usedSessions.add(clock.date);
  }
  return { candidates, diagnostics };
}

function simulate(bars: Candle[], candidates: Candidate[], arm: "original" | "inverse" | "random", seed = 0): ArmResult {
  let openUntil = Number.NEGATIVE_INFINITY; const results: number[] = [];
  for (const candidate of candidates) {
    const at = Date.parse(candidate.decisionTime); if (at < openUntil) continue;
    const direction = arm === "original" ? candidate.signalDirection : arm === "inverse" ? opposite(candidate.signalDirection) : randomDirection(candidate.decisionTime, seed);
    const bar = bars[candidate.index]!; const entry = direction === "long" ? bar.askClose : bar.bidClose; const stop = direction === "long" ? entry - candidate.riskDistance : entry + candidate.riskDistance; const target = direction === "long" ? entry + candidate.targetDistance : entry - candidate.targetDistance;
    const outcome = labelOutcome(direction, entry, stop, target, candidate.decisionTime, bars.slice(candidate.index + 1, candidate.index + 193)); const releasedAt = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : at + 48 * 3_600_000; openUntil = releasedAt;
    // Ambiguous intrabar paths are conservatively retained as the resolver's -1R.
    if (outcome.resultR !== null) results.push(outcome.resultR);
  }
  const totalR = results.reduce((sum, value) => sum + value, 0); const wins = results.filter((value) => value > 0).length;
  return { n: results.length, wins, totalR, expectancyR: results.length ? totalR / results.length : 0, winRate: results.length ? wins / results.length : 0, ci95: ci95(results) };
}

const developmentDataEnd = new Date(Date.parse(developmentEnd) + 2 * 86_400_000).toISOString(); const developmentBars = await fetchM15(developmentDataEnd); const developmentBuild = candidatesFor(developmentBars, developmentStart, developmentEnd); const developmentCandidates = developmentBuild.candidates; const development = simulate(developmentBars, developmentCandidates, "original"); const developmentInverse = simulate(developmentBars, developmentCandidates, "inverse"); const randomDevelopment = Array.from({ length: 100 }, (_, seed) => simulate(developmentBars, developmentCandidates, "random", seed + 1)); const beatsDevelopmentControls = randomDevelopment.filter((result) => development.expectancyR > result.expectancyR).length;
const qualifies = development.n >= 35 && development.expectancyR > 0 && development.ci95[0] > 0 && development.expectancyR > developmentInverse.expectancyR && beatsDevelopmentControls >= 95;
const setupDescription = mode === "fade" ? "Asian range 00:00-07:00 Europe/London; 08:00 London M15 pierces the range then closes back inside" : mode === "pullback" ? "Asian range 00:00-07:00 Europe/London; 08:00-11:00 break, retest of the broken boundary, then M15 resumption" : "Asian range 00:00-07:00 Europe/London; first 08:00 London M15 close beyond the range";
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), engine: engineName, methodology: { source: "raw OANDA bid/ask M15 candles fetched at runtime", setup: setupDescription, filters: mode === "pullback" ? "Asian range 0.35-1.2 session-volatility units; retest-swing risk 0.4-2.5 M15 ATR" : "Asian range 0.35-1.2 session-volatility units; risk 0.4-2.5 session-volatility units", exit: "1.5R target, production labelOutcome bid/ask resolver, forced-session/time close", split: { development: "2025-08-01 through 2026-03-31", sealedHoldout: "2026-04-01 through 2026-07-31" }, controls: "exact inverse with separate bid/ask fill and identical risk/target distance; 100 deterministic random arms", excluded: "all recorded trades and database reads/writes" }, development: { candidates: developmentCandidates.length, diagnostics: developmentBuild.diagnostics, original: development, inverse: developmentInverse, randomControls: { count: 100, meanExpectancyR: randomDevelopment.reduce((sum, result) => sum + result.expectancyR, 0) / randomDevelopment.length, controlsBeatenByOriginal: beatsDevelopmentControls }, gate: "n >= 35; positive expectancy; 95% normal CI lower bound > 0; original beats inverse and at least 95/100 random controls" }, verdict: qualifies ? "QUALIFIED_FOR_SEALED_HOLDOUT" : "NO_ENGINE_QUALIFIED_HOLDOUT_REMAINS_UNREAD" };
if (qualifies) { const holdoutBars = await fetchM15(new Date(Date.parse(holdoutEnd) + 2 * 86_400_000).toISOString()); const holdoutBuild = candidatesFor(holdoutBars, developmentEnd, holdoutEnd); const original = simulate(holdoutBars, holdoutBuild.candidates, "original"); const inverse = simulate(holdoutBars, holdoutBuild.candidates, "inverse"); const random = Array.from({ length: 100 }, (_, seed) => simulate(holdoutBars, holdoutBuild.candidates, "random", seed + 1)); report.holdout = { candidates: holdoutBuild.candidates.length, diagnostics: holdoutBuild.diagnostics, original, inverse, randomControls: { count: 100, meanExpectancyR: random.reduce((sum, result) => sum + result.expectancyR, 0) / random.length, controlsBeatenByOriginal: random.filter((result) => original.expectancyR > result.expectancyR).length } }; }
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
