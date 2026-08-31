/**
 * binary-master-v1 — metrics, settlement, martingale.
 */
export type Dir = "CALL" | "PUT";
export type Result = "WIN" | "LOSS" | "TIE";

export function wilson(wins: number, n: number, z = 1.96) {
  if (!n) return { lower: 0, upper: 0, center: 0 };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lower: (c - m) / d, upper: (c + m) / d, center: p };
}

export function settle(dir: Dir, entry: number, expiry: number): Result {
  if (expiry === entry) return "TIE";
  if (dir === "CALL") return expiry > entry ? "WIN" : "LOSS";
  return expiry < entry ? "WIN" : "LOSS";
}

export type TradeStats = {
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  decided: number;
  winRate: number;
  ciLower: number;
  ciUpper: number;
  sampleFlag: string;
};

export function stats(wins: number, losses: number, ties: number): TradeStats {
  const decided = wins + losses;
  const signals = decided + ties;
  const ci = wilson(wins, decided);
  let sampleFlag = "VERY_LOW_SAMPLE";
  if (decided >= 2000) sampleFlag = "LARGE_SAMPLE";
  else if (decided >= 500) sampleFlag = "MODERATE_SAMPLE";
  else if (decided >= 100) sampleFlag = "LOW_SAMPLE";
  return {
    signals,
    wins,
    losses,
    ties,
    decided,
    winRate: decided ? wins / decided : 0,
    ciLower: ci.lower,
    ciUpper: ci.upper,
    sampleFlag,
  };
}

export function fmtPct(x: number, d = 2): string {
  return (x * 100).toFixed(d) + "%";
}

export function breakEvenWr(payout: number): number {
  return 1 / (1 + payout);
}

export function evPerUnit(wr: number, payout: number): number {
  return wr * payout - (1 - wr);
}

export type MartingaleSummary = {
  sequences: number;
  sequenceSuccess: number;
  fullFailure: number;
  sequenceSuccessRate: number;
  simpleDoublingPL: number;
  recoverySizingPL: number;
  maxDrawdown: number;
  worstSequenceLoss: number;
  largestStake: number;
};

export function simulateMartingale(
  outcomes: Result[],
  payout = 0.8,
  maxAttempts = 4,
): MartingaleSummary {
  let sequences = 0, sequenceSuccess = 0, fullFailure = 0;
  let simplePL = 0, recoveryPL = 0, maxDD = 0, cumSimple = 0, cumRecovery = 0;
  let worstSeq = 0, largestStake = 1;

  for (let i = 0; i < outcomes.length; i++) {
    sequences++;
    let won = false;
    let seqSimple = 0, seqRecovery = 0;
    let stakeSimple = 1, stakeRecovery = 1;
    let lossAccumRecovery = 0;

    for (let a = 0; a < maxAttempts && i + a < outcomes.length; a++) {
      const o = outcomes[i + a]!;
      if (o === "TIE") continue;
      largestStake = Math.max(largestStake, stakeSimple, stakeRecovery);
      if (o === "WIN") {
        seqSimple += stakeSimple * payout;
        seqRecovery += stakeRecovery * payout;
        won = true;
        i += a;
        break;
      }
      seqSimple -= stakeSimple;
      seqRecovery -= stakeRecovery;
      lossAccumRecovery += stakeRecovery;
      stakeSimple *= 2;
      stakeRecovery = (lossAccumRecovery + 1) / payout;
    }
    if (!won) {
      fullFailure++;
      i += maxAttempts - 1;
    } else sequenceSuccess++;

    cumSimple += seqSimple;
    cumRecovery += seqRecovery;
    maxDD = Math.max(maxDD, Math.max(0, -Math.min(cumSimple, cumRecovery)));
    worstSeq = Math.min(worstSeq, seqSimple, seqRecovery);
  }

  return {
    sequences,
    sequenceSuccess,
    fullFailure,
    sequenceSuccessRate: sequences ? sequenceSuccess / sequences : 0,
    simpleDoublingPL: cumSimple,
    recoverySizingPL: cumRecovery,
    maxDrawdown: maxDD,
    worstSequenceLoss: worstSeq,
    largestStake,
  };
}
