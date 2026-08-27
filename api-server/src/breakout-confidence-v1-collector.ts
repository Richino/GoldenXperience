/**
 * Breakout-confidence-v1 collector.
 *
 * One-cycle runner. Called from server.ts on a 60-second interval (same cadence
 * as paper-cycle's multi-strategy collector — breakout signals fire on M15 bar
 * closes, so 60s catches them promptly).
 *
 * Pattern:
 *   1. Read the multi-strategy snapshot (same call paper-cycle makes)
 *   2. For each instrument with a valid breakout candidate on a trained pair
 *      (EUR_USD, GBP_USD, USD_JPY): extract features → run model → apply rule
 *   3. When the model confidently disagrees, rebuild geometry and open a paper
 *      trade tagged strategy_family="breakout-confidence-v1"
 *
 * Envs:
 *   BREAKOUT_CONFIDENCE_V1_ENABLED  = "true" | "false" (default false — must opt in)
 *   BREAKOUT_CONFIDENCE_V1_DRY_RUN  = "true" | "false" (default true — safe)
 *   BREAKOUT_V1_ACCOUNT_BALANCE     = number (default 10000)
 *   BREAKOUT_V1_RISK_PERCENT        = number (default 1)
 */
import { getMultiStrategySnapshot } from "../../frontend/src/lib/strategy/strategy-service.js";
import { dayTradingSession } from "../../frontend/src/lib/strategy/strategy-engine.js";
import { decideBreakoutDirection, loadBreakoutConfidenceArtifact, breakoutArtifactAgeDays, type BreakoutConfidenceRawFeatures } from "./breakout-confidence-v1.js";
import { openBreakoutConfidenceV1Trade } from "./breakout-confidence-v1-executor.js";

const TRAINED_PAIRS = new Set(["EUR_USD", "GBP_USD", "USD_JPY"]);

function etHourOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDayOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}

export type BreakoutConfidenceV1CollectResult = {
  ran: boolean;
  reason?: string;
  pairsChecked: number;
  setupsFired: number;
  tradesOpened: number;
  skipped: number;
  errors: number;
};

export async function collectBreakoutConfidenceV1Cycle(): Promise<BreakoutConfidenceV1CollectResult> {
  const enabled = (process.env.BREAKOUT_CONFIDENCE_V1_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled) return { ran: false, reason: "BREAKOUT_CONFIDENCE_V1_ENABLED is not true", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };

  const dryRun = (process.env.BREAKOUT_CONFIDENCE_V1_DRY_RUN ?? "true").toLowerCase() !== "false";
  const accountBalance = Number(process.env.BREAKOUT_V1_ACCOUNT_BALANCE ?? "10000");
  const riskPercent = Number(process.env.BREAKOUT_V1_RISK_PERCENT ?? "1");

  const artifact = loadBreakoutConfidenceArtifact();
  if (breakoutArtifactAgeDays(artifact) > 14) {
    console.warn(`[breakout-confidence-v1] artifact stale (${breakoutArtifactAgeDays(artifact).toFixed(1)}d) — decisions will skip`);
  }

  let setupsFired = 0, tradesOpened = 0, skipped = 0, errors = 0, pairsChecked = 0;
  try {
    const snap = await getMultiStrategySnapshot();
    for (const item of snap.instruments) {
      pairsChecked++;
      if (!TRAINED_PAIRS.has(item.instrument)) continue;
      const breakout = item.candidates.find((c) => c.family === "breakout");
      if (!breakout || breakout.status !== "valid") continue;
      if (breakout.direction === null || breakout.entry === null || breakout.stop === null || breakout.target === null) continue;
      setupsFired++;

      const quote = item.quote;
      const pip = item.instrument === "XAU_USD" ? 0.1 : item.instrument.endsWith("JPY") ? 0.01 : 0.0001;
      const spreadPips = quote ? (quote.ask - quote.bid) / pip : 0;
      const evaluatedAt = breakout.evaluatedAt;
      const session = dayTradingSession(new Date(evaluatedAt)).label;
      const passedCount = breakout.conditions.filter((c) => c.passed).length;
      const regimeClass = item.regime.regime ?? "mixed";
      const volBucket = item.regime.volatility ?? "normal";
      const trendStrength = item.regime.trendStrength ?? 0;
      const atrPips = item.regime.atrPips ?? 0;

      const feats: BreakoutConfidenceRawFeatures = {
        session, regime: regimeClass, volBucket, pair: item.instrument,
        trendStrength, atrPips, spreadPips, quality: passedCount,
        hourEt: etHourOf(evaluatedAt), dayOfWeek: etDayOf(evaluatedAt),
      };

      const { decision, pLong, artifactVersion, trainedAt } = decideBreakoutDirection({
        pair: item.instrument, breakoutDirection: breakout.direction, features: feats,
      });

      if (decision.action === "skip") { skipped++; continue; }

      const executedDirection = decision.direction;
      const stopDist = Math.abs(breakout.entry - breakout.stop);
      const targetDist = Math.abs(breakout.target - breakout.entry);
      const entry = executedDirection === "long" ? (quote?.ask ?? breakout.entry) : (quote?.bid ?? breakout.entry);
      const stop = executedDirection === "long" ? entry - stopDist : entry + stopDist;
      const target = executedDirection === "long" ? entry + targetDist : entry - targetDist;

      if (dryRun) {
        console.log(`[breakout-confidence-v1 DRY_RUN] ${item.instrument} ${executedDirection} @ ${entry.toFixed(5)} (pLong=${pLong.toFixed(3)}, orig=${decision.originalDirection})`);
        continue;
      }

      try {
        const res = await openBreakoutConfidenceV1Trade({
          instrument: item.instrument, decisionTime: evaluatedAt,
          direction: executedDirection, entry, stop, target,
          spreadPips, atrPips,
          originalDirection: decision.originalDirection, inverted: true,
          features: { ...feats, pLong, artifactVersion, trainedAt, decision },
          conditions: breakout.conditions.map((c) => ({ name: c.name, passed: c.passed, required: c.required })),
          accountBalance, riskPercent,
        });
        if (res.ok) {
          tradesOpened++;
          console.log(`[breakout-confidence-v1] opened trade #${res.tradeSequence} ${item.instrument} ${executedDirection} in batch ${res.batchNumber}`);
        } else {
          console.log(`[breakout-confidence-v1] ${item.instrument} not opened: ${res.reason}`);
        }
      } catch (err) {
        errors++;
        console.error(`[breakout-confidence-v1] ${item.instrument} trade insert error`, err);
      }
    }
  } catch (err) {
    errors++;
    console.error("[breakout-confidence-v1] snapshot error", err);
  }

  return { ran: true, pairsChecked, setupsFired, tradesOpened, skipped, errors };
}
