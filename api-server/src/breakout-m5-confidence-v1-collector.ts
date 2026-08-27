/**
 * Breakout-m5-confidence-v1 collector.
 *
 * Fetches M5/H1 OANDA candles for EUR/GBP/USD_JPY, evaluates the M5 setup on
 * the last completed bar, applies the flip rule (take when model disagrees),
 * opens paper trades tagged strategy_family="breakout-m5-confidence-v1".
 *
 * DISCIPLINE (per validation report): 30 days DRY_RUN first, then micro-risk
 * (0.25%) for 100 trades, then scale to 1%. Env vars govern this.
 */
import type { M5Candle } from "./breakout-m5-confidence-v1.js";
import {
  evaluateM5BreakoutSetup, decideM5Direction, loadBreakoutM5Artifact,
  breakoutM5ArtifactAgeDays, type BreakoutM5Features,
} from "./breakout-m5-confidence-v1.js";
import { openBreakoutM5Trade } from "./breakout-m5-confidence-v1-executor.js";

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TRAINED_PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const GRAN_MIN: Record<string, number> = { M5: 5, H1: 60 };

async function fetchCandles(inst: string, gran: string, count: number, token: string, host: string): Promise<M5Candle[]> {
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

export type BreakoutM5CollectResult = {
  ran: boolean; reason?: string;
  pairsChecked: number; setupsFired: number; tradesOpened: number; skipped: number; errors: number;
};

export async function collectBreakoutM5Cycle(): Promise<BreakoutM5CollectResult> {
  const enabled = (process.env.BREAKOUT_M5_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled) return { ran: false, reason: "BREAKOUT_M5_ENABLED is not true", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };

  const dryRun = (process.env.BREAKOUT_M5_DRY_RUN ?? "true").toLowerCase() !== "false";
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!token) return { ran: false, reason: "no OANDA credentials", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };
  const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const accountBalance = Number(process.env.BREAKOUT_M5_ACCOUNT_BALANCE ?? "10000");
  const riskPercent = Number(process.env.BREAKOUT_M5_RISK_PERCENT ?? "0.25");

  const artifact = loadBreakoutM5Artifact();
  if (breakoutM5ArtifactAgeDays(artifact) > 14) {
    console.warn(`[breakout-m5-confidence-v1] artifact stale (${breakoutM5ArtifactAgeDays(artifact).toFixed(1)}d)`);
  }

  let setupsFired = 0, tradesOpened = 0, skipped = 0, errors = 0;
  for (const pair of TRAINED_PAIRS) {
    try {
      const [m5, h1] = await Promise.all([
        fetchCandles(pair, "M5", 50, token, host),
        fetchCandles(pair, "H1", 100, token, host),
      ]);
      if (m5.length < 30 || h1.length < 50) continue;
      const setup = evaluateM5BreakoutSetup(pair, m5, h1);
      if (!setup.passed) continue;
      setupsFired++;

      const feats: BreakoutM5Features = {
        pair, sessionHourEt: setup.sessionHourEt,
        atrPips: setup.atrPips, rangeWidthAtr: setup.rangeWidthAtr,
        spreadPips: setup.spreadPips, decisionTime: setup.decisionTime,
      };
      const { decision, pLong, artifactVersion, trainedAt } = decideM5Direction({
        pair, breakoutDirection: setup.direction, features: feats,
      });
      if (decision.action === "skip") { skipped++; continue; }

      const executedDirection = decision.direction;
      const bar = m5[m5.length - 1]!;
      const stopDist = Math.abs(setup.entry - setup.stop);
      const targetDist = Math.abs(setup.target - setup.entry);
      const entry = executedDirection === "long" ? bar.askClose : bar.bidClose;
      const stop = executedDirection === "long" ? entry - stopDist : entry + stopDist;
      const target = executedDirection === "long" ? entry + targetDist : entry - targetDist;

      if (dryRun) {
        console.log(`[breakout-m5-confidence-v1 DRY_RUN] ${pair} ${executedDirection} @ ${entry.toFixed(5)} pLong=${pLong.toFixed(3)} orig=${decision.originalDirection}`);
        continue;
      }

      try {
        const res = await openBreakoutM5Trade({
          instrument: pair, decisionTime: setup.decisionTime,
          direction: executedDirection, entry, stop, target,
          spreadPips: setup.spreadPips, atrPips: setup.atrPips,
          originalDirection: decision.originalDirection, inverted: true,
          features: { ...feats, pLong, artifactVersion, trainedAt, decision },
          conditions: [
            { name: "M5 breakout", passed: true },
            { name: "H1 alignment", passed: true },
            { name: "confidence disagreement", passed: true },
          ],
          accountBalance, riskPercent,
        });
        if (res.ok) {
          tradesOpened++;
          console.log(`[breakout-m5-confidence-v1] opened #${res.tradeSequence} ${pair} ${executedDirection} in batch ${res.batchNumber}`);
        } else {
          console.log(`[breakout-m5-confidence-v1] ${pair} not opened: ${res.reason}`);
        }
      } catch (err) {
        errors++;
        console.error(`[breakout-m5-confidence-v1] ${pair} trade insert error`, err);
      }
    } catch (err) {
      errors++;
      console.error(`[breakout-m5-confidence-v1] ${pair} cycle error`, err);
    }
  }
  return { ran: true, pairsChecked: TRAINED_PAIRS.length, setupsFired, tradesOpened, skipped, errors };
}
