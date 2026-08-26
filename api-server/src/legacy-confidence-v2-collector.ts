/**
 * Legacy-confidence-v2 collector.
 *
 * The runtime entry point for the live daemon — one cycle = one fetch/detect/decide
 * pass across all pairs. Called from server.ts on a 15-minute interval and
 * from scripts/run-legacy-confidence-v2-daemon.ts for manual invocations.
 *
 * When LEGACY_CONFIDENCE_V2_DRY_RUN is true (default), decisions are logged
 * to stdout only. Set the env var to "false" to actually open paper trades
 * via legacy-confidence-v2-executor.
 */
import type { LegacyCandle } from "./legacy-setup-detector.js";
import { evaluateLegacySetup, atr, rsi } from "./legacy-setup-detector.js";
import { decideDirection, loadLegacyConfidenceArtifact, artifactAgeDays, type LegacyConfidenceFeatures } from "./legacy-confidence-v2.js";
import { openLegacyConfidenceV2Trade } from "./legacy-confidence-v2-executor.js";

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";

const ALL_PAIRS = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD"];
const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };

async function fetchCandles(inst: string, gran: string, count: number, token: string, host: string): Promise<LegacyCandle[]> {
  const url = `${host}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=${count}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
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

function etHourOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDayOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function computeFeatures(m15: LegacyCandle[]): LegacyConfidenceFeatures | null {
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

export type LegacyConfidenceV2CollectResult = {
  ran: boolean;
  reason?: string;
  pairsChecked: number;
  setupsFired: number;
  tradesOpened: number;
  skipped: number;
  errors: number;
};

/**
 * Run one collection cycle. Safe to call on a timer. Returns a summary; never
 * throws — errors are counted and logged.
 *
 * Environment:
 *   LEGACY_CONFIDENCE_V2_ENABLED  = "true" | "false" (default false — must opt in)
 *   LEGACY_CONFIDENCE_V2_DRY_RUN  = "true" | "false" (default true — safe by default)
 *   LEGACY_V2_ACCOUNT_BALANCE     = number (default 10000)
 *   LEGACY_V2_RISK_PERCENT        = number (default 1)
 *   LEGACY_V2_PAIRS               = comma list (default all 12)
 *   OANDA_API_KEY / OANDA_API_TOKEN, OANDA_ENVIRONMENT
 */
export async function collectLegacyConfidenceV2Cycle(): Promise<LegacyConfidenceV2CollectResult> {
  const enabled = (process.env.LEGACY_CONFIDENCE_V2_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled) return { ran: false, reason: "LEGACY_CONFIDENCE_V2_ENABLED is not true", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };

  const dryRun = (process.env.LEGACY_CONFIDENCE_V2_DRY_RUN ?? "true").toLowerCase() !== "false";
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!token) return { ran: false, reason: "no OANDA credentials", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };
  const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const pairs = process.env.LEGACY_V2_PAIRS ? process.env.LEGACY_V2_PAIRS.split(",").map((s) => s.trim()).filter(Boolean) : ALL_PAIRS;
  const accountBalance = Number(process.env.LEGACY_V2_ACCOUNT_BALANCE ?? "10000");
  const riskPercent = Number(process.env.LEGACY_V2_RISK_PERCENT ?? "1");

  const artifact = loadLegacyConfidenceArtifact();
  if (artifactAgeDays(artifact) > 14) {
    console.warn(`[legacy-confidence-v2] artifact stale (${artifactAgeDays(artifact).toFixed(1)}d) — all decisions will skip`);
  }

  let setupsFired = 0, tradesOpened = 0, skipped = 0, errors = 0;

  for (const pair of pairs) {
    try {
      const [m15, h1, h4] = await Promise.all([
        fetchCandles(pair, "M15", 500, token, host),
        fetchCandles(pair, "H1", 300, token, host),
        fetchCandles(pair, "H4", 200, token, host),
      ]);
      if (m15.length < 210 || h1.length < 60 || h4.length < 60) continue;
      const setup = evaluateLegacySetup(pair, m15, h1, h4);
      if (!setup.passed) continue;
      setupsFired++;
      const feats = computeFeatures(m15);
      if (!feats) { errors++; continue; }
      const { decision, pLong, artifactVersion, trainedAt } = decideDirection({
        pair, legacyDirection: setup.direction, features: feats,
      });
      if (decision.action === "skip") { skipped++; continue; }

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

      if (dryRun) {
        console.log(`[legacy-confidence-v2 DRY_RUN] ${pair} ${executedDirection} @ ${entry.toFixed(5)} (pLong=${pLong.toFixed(3)}, inverted=${inverted})`);
      } else {
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
          accountBalance,
          riskPercent,
        });
        if (res.ok) {
          tradesOpened++;
          console.log(`[legacy-confidence-v2] opened trade #${res.tradeSequence} ${pair} ${executedDirection} in batch ${res.batchNumber}`);
        } else {
          console.log(`[legacy-confidence-v2] ${pair} not opened: ${res.reason}`);
        }
      }
    } catch (err) {
      errors++;
      console.error(`[legacy-confidence-v2] ${pair} cycle error`, err);
    }
  }

  return { ran: true, pairsChecked: pairs.length, setupsFired, tradesOpened, skipped, errors };
}
