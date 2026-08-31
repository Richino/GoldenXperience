/**
 * Research-only all-OANDA-pairs replay for the frozen binary-fade-v1 rule.
 *
 * Streams completed OANDA M1 midpoint candles from 2022-01-01 onwards without
 * persisting the raw archive. The checkpoint makes the expensive broker read
 * resumable after each instrument. No database or production state is changed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

import {
  BINARY_FADE_CONFIGURATION,
  BINARY_FADE_MIN_EXTENSION_ATR,
  BINARY_FADE_MODEL_NAME,
  BINARY_FADE_MODEL_VERSION,
  BINARY_FADE_RSI_HIGH,
  isFadeExcluded,
} from "../src/binary-fade-v1.js";
import {
  classifyBinaryResult,
  type BinaryCandle,
} from "../src/binary-engine.js";

const START = "2022-01-01T00:00:00.000Z";
let replayEnd = new Date(Date.now() - 2 * 60_000).toISOString();
const PAGE_SIZE = 5_000;
const REQUEST_DELAY_MS = 140;
const WINDOW = 80;
const HORIZON_MS = 10 * 60_000;
const OUTPUT_DIR = path.join(serviceRoot, "research-v2", "binary-fade-v1-all-oanda-2022");
const STATE_PATH = path.join(OUTPUT_DIR, "STATE.json");
const RESULT_PATH = path.join(OUTPUT_DIR, "RESULTS.json");
const REPORT_PATH = path.join(OUTPUT_DIR, "FINAL_REPORT.txt");

type Instrument = { name: string; type: string; displayPrecision: number };
type OandaCandle = { time: string; complete: boolean; mid?: { o: string; h: string; l: string; c: string }; volume: number };
type OandaResponse = { candles?: OandaCandle[] };
type Result = "won" | "lost" | "tie";
type Trade = { at: string; direction: "up" | "down"; result: Result };
type PairResult = { instrument: string; precision: number; fetchedBars: number; firstBar: string | null; lastBar: string | null; signals: number; skippedWhileActive: number; trades: Trade[]; error?: string };
type State = { startedAt: string; end: string; pairs: string[]; results: Record<string, PairResult> };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim();
const accountId = (process.env.OANDA_ACCOUNT_ID ?? "").trim();
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
if (!token || !accountId) throw new Error("OANDA credentials are required for this research replay.");

function saveJson(file: string, value: unknown) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readState(): State | null {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`OANDA ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function currencyPairs(): Promise<Instrument[]> {
  const response = await requestJson<{ instruments: Instrument[] }>(`${host}/v3/accounts/${encodeURIComponent(accountId)}/instruments`);
  return response.instruments
    .filter((instrument) => instrument.type === "CURRENCY")
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toBinary(candle: OandaCandle): BinaryCandle | null {
  if (!candle.complete || !candle.mid) return null;
  const { o, h, l, c } = candle.mid;
  const values = [Number(o), Number(h), Number(l), Number(c)];
  if (!values.every(Number.isFinite)) return null;
  return { time: candle.time, open: values[0]!, high: values[1]!, low: values[2]!, close: values[3]!, volume: candle.volume, complete: true };
}

function yearOf(iso: string) { return iso.slice(0, 4); }

/**
 * The exact subset of computeBinaryFeatures used by binary-fade-v1.
 * It avoids constructing EMAs, session labels, and quote fields that the fade
 * model never reads, while preserving the live engine's rolling-80 ATR,
 * trailing-20 population Bollinger band, and trailing-15-close RSI formula.
 */
function fadeDirection(instrument: string, candles: readonly BinaryCandle[]): "up" | "down" | null {
  if (isFadeExcluded(instrument) || candles.length < WINDOW) return null;
  let previousAtr: number | null = null;
  let atr: number | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    const bar = candles[index]!;
    const priorClose = candles[index - 1]?.close ?? bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
    if (index < 13) continue;
    if (previousAtr === null) {
      let seed = 0;
      for (let seedIndex = index - 13; seedIndex <= index; seedIndex += 1) {
        const seedBar = candles[seedIndex]!;
        const seedPriorClose = candles[seedIndex - 1]?.close ?? seedBar.close;
        seed += Math.max(seedBar.high - seedBar.low, Math.abs(seedBar.high - seedPriorClose), Math.abs(seedBar.low - seedPriorClose));
      }
      previousAtr = seed / 14;
    } else previousAtr = (previousAtr * 13 + tr) / 14;
    atr = previousAtr;
  }
  if (atr === null || atr <= 0) return null;
  const last20 = candles.slice(-20);
  const mean = last20.reduce((sum, candle) => sum + candle.close, 0) / 20;
  const stdev = Math.sqrt(last20.reduce((sum, candle) => sum + (candle.close - mean) ** 2, 0) / 20);
  const upper = mean + 2 * stdev;
  const lower = mean - 2 * stdev;
  const price = candles.at(-1)!.close;
  const rsiWindow = candles.slice(-15);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < rsiWindow.length; index += 1) {
    const change = rsiWindow[index]!.close - rsiWindow[index - 1]!.close;
    if (change >= 0) gain += change; else loss -= change;
  }
  gain /= 14;
  loss /= 14;
  const rsi = loss === 0 ? (gain === 0 ? null : 100) : 100 - 100 / (1 + gain / loss);
  if (rsi === null) return null;
  if (price > upper && (price - upper) / atr >= BINARY_FADE_MIN_EXTENSION_ATR && rsi > BINARY_FADE_RSI_HIGH) return "down";
  if (price < lower && (lower - price) / atr >= BINARY_FADE_MIN_EXTENSION_ATR && rsi < 100 - BINARY_FADE_RSI_HIGH) return "up";
  return null;
}

function wilsonLower(wins: number, n: number, z = 1.96) {
  if (!n) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (centre - margin) / denom;
}

type Metrics = { n: number; won: number; lost: number; tie: number; winRate: number | null; wilsonLow: number | null; ev80: number | null };
function metrics(trades: readonly Trade[]): Metrics {
  const won = trades.filter((trade) => trade.result === "won").length;
  const lost = trades.filter((trade) => trade.result === "lost").length;
  const tie = trades.length - won - lost;
  const n = won + lost;
  return { n, won, lost, tie, winRate: n ? won / n : null, wilsonLow: wilsonLower(won, n), ev80: n ? (0.8 * won - lost) / n : null };
}

function strength(pair: PairResult) {
  const recent = pair.trades.filter((trade) => trade.at >= "2024-01-01T00:00:00.000Z");
  const total = metrics(recent);
  const years = ["2024", "2025", "2026"].map((year) => metrics(recent.filter((trade) => yearOf(trade.at) === year)));
  const yearsWithEvidence = years.filter((row) => row.n >= 30);
  const profitableYears = yearsWithEvidence.filter((row) => (row.ev80 ?? -Infinity) > 0).length;
  if (total.n < 100 || yearsWithEvidence.length < 2) return "UNCERTAIN";
  if ((total.wilsonLow ?? 0) > 1 / 1.8 && profitableYears >= 2) return "KEEP";
  if ((total.winRate ?? 1) < 1 / 1.8 && profitableYears === 0) return "DROP";
  return "WATCH";
}

async function replayPair(instrument: Instrument): Promise<PairResult> {
  const result: PairResult = { instrument: instrument.name, precision: instrument.displayPrecision, fetchedBars: 0, firstBar: null, lastBar: null, signals: 0, skippedWhileActive: 0, trades: [] };
  const window: BinaryCandle[] = [];
  let cursor = START;
  let active: { at: string; entry: number; direction: "up" | "down"; targetMs: number } | null = null;
  for (let page = 1; page <= 700; page += 1) {
    // OANDA accepts either a time range or a count. `from + count` pages
    // forward; adding `to` makes the broker reject the request as ambiguous.
    const params = new URLSearchParams({ price: "M", granularity: "M1", from: cursor, count: String(PAGE_SIZE) });
    const response = await requestJson<OandaResponse>(`${host}/v3/instruments/${instrument.name}/candles?${params}`);
    const candles = (response.candles ?? []).map(toBinary).filter((item): item is BinaryCandle => item !== null);
    if (!candles.length) break;
    let lastOpenMs = Date.parse(candles.at(-1)!.time);
    for (const candle of candles) {
      const closeMs = Date.parse(candle.time) + 60_000;
      if (active && closeMs >= active.targetMs) {
        result.trades.push({ at: active.at, direction: active.direction, result: classifyBinaryResult(active.direction, active.entry, candle.close, instrument.displayPrecision) });
        active = null;
      }
      window.push(candle);
      if (window.length > WINDOW) window.shift();
      result.fetchedBars += 1;
      result.firstBar ??= candle.time;
      result.lastBar = candle.time;
      if (window.length < WINDOW || active) continue;
      const direction = fadeDirection(instrument.name, window);
      if (!direction) continue;
      result.signals += 1;
      active = { at: new Date(closeMs).toISOString(), entry: candle.close, direction, targetMs: closeMs + HORIZON_MS };
    }
    if (page % 25 === 0) console.log(`  ${instrument.name}: page ${page}, ${result.fetchedBars.toLocaleString()} completed M1 bars, ${result.trades.length} resolved trades`);
    if (candles.length < PAGE_SIZE || lastOpenMs >= Date.parse(replayEnd) - 60_000) break;
    cursor = new Date(lastOpenMs + 60_000).toISOString();
    await sleep(REQUEST_DELAY_MS);
  }
  return result;
}

function render(state: State) {
  const rows = Object.values(state.results).sort((a, b) => strength(a).localeCompare(strength(b)) || (metrics(b.trades.filter((trade) => trade.at >= "2024-01-01")).ev80 ?? -Infinity) - (metrics(a.trades.filter((trade) => trade.at >= "2024-01-01")).ev80 ?? -Infinity));
  const lines = [
    "GOLDENXPERIENCE — BINARY FADE V1 ALL-OANDA-FOREX REPLAY",
    "RESEARCH ONLY — no database writes and no production/paper-trading changes.",
    `Run range: ${START} → ${state.end}`,
    `Model: ${BINARY_FADE_MODEL_NAME} v${BINARY_FADE_MODEL_VERSION}; ${JSON.stringify(BINARY_FADE_CONFIGURATION)}`,
    "Resolution: first completed M1 midpoint close at or after entry close + 10 minutes; ties remain ties.",
    "Decision constraint: one active binary prediction per instrument.",
    "Selection uses 2024–2026 YTD only. 2022–2023 remains context, not a promotion score.",
    "KEEP: >=100 decided recent trades, >=2 years with >=30 trades, Wilson lower bound above 55.56%, and positive EV80 in >=2 evidence years.",
    "DROP: >=100 decided recent trades, aggregate win rate below 55.56%, and no evidence year with positive EV80. Others are WATCH or UNCERTAIN.",
    "",
    "pair\tverdict\trecent_n\trecent_wr\twilson_low\tev80\t2024_n/wr\t2025_n/wr\t2026_n/wr\tall_n",
  ];
  for (const pair of rows) {
    const recent = pair.trades.filter((trade) => trade.at >= "2024-01-01");
    const m = metrics(recent);
    const byYear = ["2024", "2025", "2026"].map((year) => metrics(recent.filter((trade) => yearOf(trade.at) === year)));
    const fmt = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
    lines.push(`${pair.instrument}\t${strength(pair)}\t${m.n}\t${fmt(m.winRate)}\t${fmt(m.wilsonLow)}\t${m.ev80 === null ? "n/a" : m.ev80.toFixed(3)}\t${byYear.map((year) => `${year.n}/${fmt(year.winRate)}`).join("\t")}\t${metrics(pair.trades).n}`);
  }
  return `${lines.join("\n")}\n`;
}

const instruments = await currencyPairs();
let state = readState();
if (!state) state = { startedAt: new Date().toISOString(), end: replayEnd, pairs: instruments.map((instrument) => instrument.name), results: {} };
replayEnd = state.end;
console.log(`Replaying ${instruments.length} OANDA currency pairs from ${START} to ${replayEnd}. Resume checkpoint: ${STATE_PATH}`);
for (const instrument of instruments) {
  if (state.results[instrument.name] && !state.results[instrument.name]!.error) { console.log(`SKIP ${instrument.name}: checkpoint complete`); continue; }
  console.log(`START ${instrument.name}`);
  try {
    state.results[instrument.name] = await replayPair(instrument);
  } catch (error) {
    state.results[instrument.name] = { instrument: instrument.name, precision: instrument.displayPrecision, fetchedBars: 0, firstBar: null, lastBar: null, signals: 0, skippedWhileActive: 0, trades: [], error: error instanceof Error ? error.message : String(error) };
  }
  saveJson(STATE_PATH, state);
  saveJson(RESULT_PATH, state);
  fs.writeFileSync(REPORT_PATH, render(state));
  const current = state.results[instrument.name]!;
  console.log(`DONE ${instrument.name}: ${current.fetchedBars.toLocaleString()} bars; ${current.trades.length} resolved; ${strength(current)}`);
}
fs.writeFileSync(REPORT_PATH, render(state));
console.log(`Complete. Report: ${REPORT_PATH}`);
