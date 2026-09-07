/**
 * V5 failure diagnosis. Research-only. Attributes the out-of-sample loss to
 * direction / opportunity-selection / entry-timing / costs / geometry, and tests
 * the news-direction premise independently of the model. No mirror math.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidates, trainHeads, scoreAndThreshold, resolveOutcomeGeo, isEligible, marketDays,
  addUtcMonths, geoKey, ARCHS, GEOMETRIES, WINDOW_FROM, TEST, CALIBRATION_MONTHS,
  WALKFORWARD_STEP_MONTHS, WALKFORWARD_MIN_TRAIN_MONTHS, MIN_STOP_PIPS, PIP,
  type Geo, type V5Candidate,
} from "./experiment.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v5");

// Frozen selection (from the experiment's validation-only selection).
const SEL_ARCH = ARCHS.find((a) => a.name === "mlp-16")!;
const SEL_GEO: Geo = { stopAtr: 1.5, rr: 2.5 };
const SEL_COVERAGE = 0.2;
const SEL_CONF = 0;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pf = (xs: number[]) => {
  const gp = xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -xs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return gl ? gp / gl : Infinity;
};

type Rec = {
  time: number; dir: 1 | -1; net: number; opp: number; gross: number; cost: number;
  mfeR: number; rank: number; quality: number; conf: number; isNews: boolean;
  kind: string; hold: number; signed: number; betterSide: 1 | -1;
};

function mfe(bars: any[], series: any, index: number, dir: 1 | -1, geo: Geo, exitTime: number) {
  const entryIndex = index + 1;
  const stopDistance = Math.max(geo.stopAtr * series.atr14[index]!, MIN_STOP_PIPS * PIP);
  const entry = dir === 1 ? bars[entryIndex]!.askOpen : bars[entryIndex]!.bidOpen;
  let best = 0;
  for (let c = entryIndex; c < bars.length && bars[c]!.t <= exitTime; c += 1) {
    const fav = dir === 1 ? bars[c]!.bidHigh - entry : entry - bars[c]!.askLow;
    best = Math.max(best, fav / stopDistance);
  }
  return best;
}

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  const { candidates, bars, series } = buildCandidates();
  const key = geoKey(SEL_GEO);

  // ---- reproduce the frozen walk-forward, capturing rich per-trade records ----
  const recs: Rec[] = [];
  const allEligibleOOS: V5Candidate[] = [];
  let foldSeed = 0x9e37;
  for (
    let foldStart = addUtcMonths(WINDOW_FROM, WALKFORWARD_MIN_TRAIN_MONTHS);
    foldStart < TEST.to;
    foldStart = addUtcMonths(foldStart, WALKFORWARD_STEP_MONTHS)
  ) {
    const foldEnd = Math.min(TEST.to, addUtcMonths(foldStart, WALKFORWARD_STEP_MONTHS));
    const trainFold = candidates.filter((c) => c.time >= WINDOW_FROM && c.time < foldStart);
    const evalFold = candidates.filter((c) => c.time >= foldStart && c.time < foldEnd);
    if (trainFold.length < 200 || !evalFold.length) continue;
    const heads = trainHeads(trainFold, SEL_ARCH, SEL_GEO, (foldSeed += 7919));
    const calFold = candidates.filter((c) => c.time >= addUtcMonths(foldStart, -CALIBRATION_MONTHS) && c.time < foldStart);
    const scored = scoreAndThreshold(evalFold, calFold.length ? calFold : trainFold, heads, SEL_COVERAGE);
    for (const c of evalFold) if (isEligible(c)) allEligibleOOS.push(c);
    // replay gating identical to experiment.replay
    const perDay = new Map<string, number>();
    let lockedUntil = -Infinity;
    for (const row of [...scored].sort((a, b) => a.time - b.time)) {
      if (!isEligible(row) || row.rankScore < row.threshold || row.directionConfidence < SEL_CONF) continue;
      if (row.time < lockedUntil || (perDay.get(row.day) ?? 0) >= 3) continue;
      const o = row.outcomes.get(key)!;
      const chosen = row.direction === 1 ? o.long : o.short;
      const opp = row.direction === 1 ? o.short : o.long;
      const gross = resolveOutcomeGeo(bars, series, row.index, row.direction, SEL_GEO, true).r;
      recs.push({
        time: row.time, dir: row.direction, net: chosen.r, opp: opp.r, gross, cost: gross - chosen.r,
        mfeR: mfe(bars, series, row.index, row.direction, SEL_GEO, chosen.exitTime),
        rank: row.rankScore, quality: row.qualityProbability, conf: row.directionConfidence,
        isNews: row.isNewsTrade, kind: chosen.kind, hold: chosen.holdMinutes,
        signed: row.longX[20]!, betterSide: o.long.r >= o.short.r ? 1 : -1,
      });
      perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
      lockedUntil = chosen.exitTime;
    }
  }

  const nets = recs.map((r) => r.net);
  const n = recs.length;

  // 1) DIRECTION: chosen vs opposite; did the model pick the better executable side?
  const pickedBetter = recs.filter((r) => r.dir === r.betterSide).length / n;
  const directionHit = recs.filter((r) => r.gross > 0).length / n; // gross avoids cost noise
  const oppExp = mean(recs.map((r) => r.opp));

  // 2) OPPORTUNITY SELECTION: does higher rankScore => better net? (quartiles)
  const byRank = [...recs].sort((a, b) => a.rank - b.rank);
  const q = 4; const rankBuckets: any[] = [];
  for (let i = 0; i < q; i++) {
    const seg = byRank.slice(Math.floor(i * n / q), Math.floor((i + 1) * n / q));
    rankBuckets.push({ bucket: `Q${i + 1}`, n: seg.length, exp: +mean(seg.map((r) => r.net)).toFixed(4), winRate: +(seg.filter((r) => r.net > 0).length / seg.length).toFixed(3) });
  }

  // 3) ENTRY TIMING: losers that never went favorable / fast stops
  const losers = recs.filter((r) => r.net <= 0);
  const lowMfe = losers.filter((r) => r.mfeR < 0.25).length;
  const fastStop = recs.filter((r) => r.kind === "STOP" && r.hold <= 30).length;

  // 4) COSTS: gross vs net
  const grossExp = mean(recs.map((r) => r.gross));
  const netExp = mean(nets);
  const costMean = mean(recs.map((r) => r.cost));

  // 5) GEOMETRY: hold entries+direction fixed, swap exit geometry (net)
  const geomHold = GEOMETRIES.map((g) => {
    const rs = recs.map((r) => {
      const cand = candidates.find((c) => c.time === r.time)!; // entries are unique per time here
      const o = cand.outcomes.get(geoKey(g))!;
      return r.dir === 1 ? o.long.r : o.short.r;
    });
    return { geometry: geoKey(g), exp: +mean(rs).toFixed(4), pf: +Number(pf(rs)).toFixed(3), winRate: +(rs.filter((x) => x > 0).length / rs.length).toFixed(3) };
  });

  // 6) NEWS PREMISE (model-independent): does news sign predict the better executable side?
  //    Use costless (mid) outcomes to isolate pure direction, over ALL eligible OOS candidates.
  const newsCands = allEligibleOOS.filter((c) => Math.abs(c.longX[20]!) > 1e-9);
  let signAgree = 0, tradedNewsDir = [] as number[], tradedAgainst = [] as number[];
  for (const c of newsCands) {
    const gl = resolveOutcomeGeo(bars, series, c.index, 1, SEL_GEO, true).r;
    const gs = resolveOutcomeGeo(bars, series, c.index, -1, SEL_GEO, true).r;
    const betterSide = gl >= gs ? 1 : -1;
    const newsSide = c.longX[20]! > 0 ? 1 : -1;
    if (newsSide === betterSide) signAgree += 1;
    // net R of actually trading the news-implied side vs against it
    const netNewsSide = c.outcomes.get(key)![newsSide === 1 ? "long" : "short"].r;
    const netAgainst = c.outcomes.get(key)![newsSide === 1 ? "short" : "long"].r;
    tradedNewsDir.push(netNewsSide); tradedAgainst.push(netAgainst);
  }

  const diagnosis = {
    generatedAt: new Date().toISOString(),
    frozenSelection: { arch: SEL_ARCH.name, geometry: key, coverage: SEL_COVERAGE, conf: SEL_CONF },
    sample: { walkForwardTrades: n, netExpectancy: +netExp.toFixed(4), netPF: +Number(pf(nets)).toFixed(3), totalNetR: +nets.reduce((a, b) => a + b, 0).toFixed(2) },
    direction: {
      note: "chosen vs opposite are independent executable bid/ask outcomes (no mirror). directionHit uses gross to remove cost.",
      modelPickedBetterExecutableSide: +pickedBetter.toFixed(3),
      grossDirectionHitRate: +directionHit.toFixed(3),
      chosenNetExp: +netExp.toFixed(4),
      oppositeNetExp: +oppExp.toFixed(4),
    },
    opportunitySelection: { note: "higher rankScore should mean higher net expectancy", rankQuartiles: rankBuckets },
    entryTiming: {
      losers: losers.length,
      losersNeverReached025R: lowMfe,
      losersNeverReached025RShare: +(lowMfe / Math.max(1, losers.length)).toFixed(3),
      fastStopsWithin30min: fastStop,
      fastStopShareOfAll: +(fastStop / n).toFixed(3),
    },
    costs: { grossExpectancy: +grossExp.toFixed(4), netExpectancy: +netExp.toFixed(4), avgCostPerTradeR: +costMean.toFixed(4), grossPF: +Number(pf(recs.map((r) => r.gross))).toFixed(3) },
    geometry: { note: "entries+direction held fixed; only exit geometry swapped", perGeometryNet: geomHold },
    newsPremise: {
      note: "model-independent: does the signed news feature point to the better executable side? costless (mid) direction; all eligible OOS candidates carrying a news signal.",
      newsSignalCandidates: newsCands.length,
      newsSignPredictsBetterSideRate: +(signAgree / Math.max(1, newsCands.length)).toFixed(3),
      netExpTradingNewsDirection: +mean(tradedNewsDir).toFixed(4),
      netExpTradingAgainstNews: +mean(tradedAgainst).toFixed(4),
    },
  };
  writeFileSync(path.join(OUTPUT, "DIAGNOSIS.json"), JSON.stringify(diagnosis, null, 2));
  console.log(JSON.stringify(diagnosis, null, 2));
}
main();
