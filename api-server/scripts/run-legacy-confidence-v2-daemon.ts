/**
 * Legacy-confidence-v2 daemon (Path 1: standalone).
 *
 * Runs once per invocation. Meant to be called by cron every 15 min. For each
 * of the 12 pairs it:
 *   1. Fetches live OANDA M15/H1/H4 candles
 *   2. Runs the legacy 10-gate detector
 *   3. If a setup fires, computes the 7 v2 features and applies the combined rule
 *   4. Logs the decision (and, when DRY_RUN=false, opens a paper trade)
 *
 * PHASE 1 default: DRY_RUN=true. Nothing writes to the DB. All decisions are
 * printed and appended to a local log file so the user can validate the
 * detector fires cleanly on live data before we wire DB writes.
 *
 * Env:
 *   DRY_RUN=false          → enable actual paper-trade insertion (Phase 2, not yet built)
 *   LOG_PATH=<file>        → override the decision log file
 *   PAIRS=EUR_USD,GBP_USD  → limit to specific pairs (default: all 12)
 *
 * Usage:
 *   npx tsx scripts/run-legacy-confidence-v2-daemon.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

import type { LegacyCandle } from "../src/legacy-setup-detector.js";
const { evaluateLegacySetup, atr, rsi } = await import("../src/legacy-setup-detector.js");
const { decideDirection, loadLegacyConfidenceArtifact, artifactAgeDays } = await import("../src/legacy-confidence-v2.js");
const { openLegacyConfidenceV2Trade } = await import("../src/legacy-confidence-v2-executor.js");

const ACCOUNT_BALANCE = Number(process.env.LEGACY_V2_ACCOUNT_BALANCE ?? "10000");
const RISK_PERCENT = Number(process.env.LEGACY_V2_RISK_PERCENT ?? "1");

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const LOG_DIR = path.join(serviceRoot, "research-v2", "legacy-confidence-v2-live-log");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = process.env.LOG_PATH ?? path.join(LOG_DIR, "decisions.jsonl");

const ALL_PAIRS = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD"];
const PAIRS = process.env.PAIRS ? process.env.PAIRS.split(",").map((s) => s.trim()).filter(Boolean) : ALL_PAIRS;

if (!TOKEN) { console.error("ERROR: OANDA_API_KEY or OANDA_API_TOKEN not set"); process.exit(2); }

const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };
async function fetchCandles(inst: string, gran: string, count: number): Promise<LegacyCandle[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=${count}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`  FETCH FAIL ${inst} ${gran} ${r.status}`); return []; }
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  const step = GRAN_MIN[gran]! * 60_000;
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    const mid = (b: number, a: number) => (b + a) / 2;
    return {
      closeTime: new Date(Date.parse(x.time) + step).toISOString(),
      open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}

// v2 features from the M15 series
function etHourOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDayOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function computeFeatures(m15: LegacyCandle[]): { atrPct: number; atrRatio: number; hourEt: number; dayOfWeek: number; rsiVelocity: number; rangePos: number; mom3: number } | null {
  const i = m15.length - 1;
  if (i < 500) return null;
  const closes = m15.map((b) => b.close);
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  const r14 = rsi(closes, 14);
  const atr14V = a14[i]!; const atr50V = a50[i]!; const closeV = closes[i]!;
  const rsiV = r14[i]!; const rsiPrev = r14[i - 3]; const closePrev3 = closes[i - 3];
  if (![atr14V, atr50V, closeV, rsiV, rsiPrev, closePrev3].every((x) => Number.isFinite(x as number))) return null;
  const atrHist = a14.slice(Math.max(0, i - 500), i).filter((v) => Number.isFinite(v));
  if (atrHist.length < 100) return null;
  let count = 0;
  for (const v of atrHist) if (v <= atr14V) count++;
  const atrPct = count / atrHist.length;
  const atrRatio = atr14V / atr50V;
  const rangeWin = m15.slice(Math.max(0, i - 20), i);
  const rangeHi = Math.max(...rangeWin.map((b) => b.high));
  const rangeLo = Math.min(...rangeWin.map((b) => b.low));
  const rangePos = rangeHi > rangeLo ? (closeV - rangeLo) / (rangeHi - rangeLo) : 0.5;
  const rsiVelocity = (rsiV - (rsiPrev as number)) / 3;
  const mom3 = (closeV - (closePrev3 as number)) / closeV;
  const iso = m15[i]!.closeTime;
  return { atrPct, atrRatio, hourEt: etHourOf(iso), dayOfWeek: etDayOf(iso), rsiVelocity, rangePos, mom3 };
}

// ---- main ----
const runId = new Date().toISOString();
console.log(`\n=== legacy-confidence-v2 daemon @ ${runId} ===`);
console.log(`DRY_RUN=${DRY_RUN}   host=${HOST}   pairs=${PAIRS.length}   log=${LOG_PATH}`);

const artifact = loadLegacyConfidenceArtifact();
console.log(`model: ${artifact.modelName} v${artifact.version} trained ${artifact.metadata.trainedAt} (${artifactAgeDays(artifact).toFixed(1)}d old)`);
if (artifactAgeDays(artifact) > 14) console.log(`WARNING: artifact stale — decideDirection() will return skip:artifact_stale`);

const summary = { runId, checked: 0, setups: 0, wouldTrade: 0, skipped: 0, noSetup: 0, dryRun: DRY_RUN, decisions: [] as Array<Record<string, unknown>> };

for (const pair of PAIRS) {
  summary.checked++;
  try {
    const [m15, h1, h4] = await Promise.all([
      fetchCandles(pair, "M15", 500),
      fetchCandles(pair, "H1", 300),
      fetchCandles(pair, "H4", 200),
    ]);
    if (m15.length < 210 || h1.length < 60 || h4.length < 60) {
      console.log(`  ${pair}: SKIP (insufficient candles: M15=${m15.length}, H1=${h1.length}, H4=${h4.length})`);
      continue;
    }
    const setup = evaluateLegacySetup(pair, m15, h1, h4);
    if (!setup.passed) {
      summary.noSetup++;
      console.log(`  ${pair}: no setup — ${setup.reason}`);
      continue;
    }
    summary.setups++;
    const feats = computeFeatures(m15);
    if (!feats) {
      console.log(`  ${pair}: setup ${setup.direction} — but feature computation failed`);
      continue;
    }
    const { decision, pLong, artifactVersion, trainedAt } = decideDirection({
      pair, legacyDirection: setup.direction, features: feats,
    });
    const rec = {
      runId, pair, decisionTime: setup.decisionTime, legacy: {
        direction: setup.direction, entry: setup.entry, stop: setup.stop, target: setup.target,
        riskPips: setup.riskPips, targetPips: setup.targetPips, atrPips: setup.atrPips, rsi14: setup.rsi14, spreadPips: setup.spreadPips,
      },
      features: feats, pLong, decision, artifact: { version: artifactVersion, trainedAt },
    };
    summary.decisions.push(rec);
    appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n");

    const msg = decision.action === "skip"
      ? `SKIP (${decision.reason})`
      : decision.action === "take_baseline"
        ? `TAKE BASELINE ${decision.direction} (${decision.reason})`
        : `TAKE MODEL ${decision.direction} (orig=${decision.originalDirection}, pLong=${decision.pLong.toFixed(3)})`;

    console.log(`  ${pair}: setup ${setup.direction} @ ${setup.entry.toFixed(5)} | pLong=${pLong.toFixed(3)} → ${msg}`);

    if (decision.action !== "skip") {
      summary.wouldTrade++;
      if (!DRY_RUN) {
        // If the model flipped the direction, rebuild geometry on the opposite
        // side of the book (mirroring stop/target distances) so the inverted
        // trade pays its own real spread — same pattern as momentum-inversion.
        const executedDirection = decision.action === "take_model_pick" ? decision.direction : setup.direction;
        const originalDirection = decision.action === "take_model_pick" ? decision.originalDirection : null;
        const inverted = decision.action === "take_model_pick";
        let entry = setup.entry, stop = setup.stop, target = setup.target;
        if (inverted) {
          const bar = m15[m15.length - 1]!;
          const stopDist = Math.abs(setup.entry - setup.stop);
          const targetDist = Math.abs(setup.target - setup.entry);
          entry = executedDirection === "long" ? bar.askClose : bar.bidClose;
          stop = executedDirection === "long" ? entry - stopDist : entry + stopDist;
          target = executedDirection === "long" ? entry + targetDist : entry - targetDist;
        }
        try {
          const res = await openLegacyConfidenceV2Trade({
            instrument: pair,
            decisionTime: setup.decisionTime,
            direction: executedDirection,
            entry, stop, target,
            spreadPips: setup.spreadPips,
            atrPips: setup.atrPips,
            originalDirection, inverted,
            features: { ...feats, pLong, artifactVersion, trainedAt, decision },
            conditions: setup.gatesPassed.map((name) => ({ name, passed: true })),
            accountBalance: ACCOUNT_BALANCE,
            riskPercent: RISK_PERCENT,
          });
          if (res.ok) {
            console.log(`    ✓ trade #${res.tradeSequence} opened in batch ${res.batchNumber}`);
            (rec as Record<string, unknown>).paperTrade = { tradeId: res.tradeId, tradeSequence: res.tradeSequence, batchNumber: res.batchNumber };
          } else {
            console.log(`    ✗ trade not opened: ${res.reason}`);
            (rec as Record<string, unknown>).paperTrade = { failed: true, reason: res.reason };
          }
        } catch (err) {
          console.log(`    ✗ trade insert error: ${(err as Error).message}`);
          (rec as Record<string, unknown>).paperTrade = { failed: true, reason: (err as Error).message };
        }
      }
    } else {
      summary.skipped++;
    }
  } catch (err) {
    console.log(`  ${pair}: ERROR ${(err as Error).message}`);
  }
}

console.log(`\n=== summary ===`);
console.log(`  pairs checked : ${summary.checked}`);
console.log(`  setups fired  : ${summary.setups}`);
console.log(`  would trade   : ${summary.wouldTrade}`);
console.log(`  skipped by v2 : ${summary.skipped}`);
console.log(`  no setup      : ${summary.noSetup}`);
console.log(`  log appended  : ${LOG_PATH}`);
if (DRY_RUN) console.log(`  DRY_RUN=true — no DB writes performed`);

process.exit(0);
