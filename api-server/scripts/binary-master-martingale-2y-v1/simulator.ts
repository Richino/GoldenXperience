/**
 * binary-master-martingale-2y-v1 — account simulation (fixed stake + Martingale).
 */
import type { MasterSignal } from "./signals.js";
import type { Result } from "../binary-master-v1/metrics.js";

export const STARTING_BALANCE = 100;
export const PAYOUT = 0.8;
export const STAKE_FRACTION = 0.01;
export const MIN_STAKE = 0.01;

export type AttemptLabel = "Base" | `MG${number}`;

export type TradeRecord = {
  seqId: number;
  attempt: number;
  attemptLabel: AttemptLabel;
  pair: string;
  direction: string;
  entryIso: string;
  expiryIso: string;
  entryPrice: number;
  expiryPrice: number;
  result: Result;
  stake: number;
  payout: number;
  pnl: number;
  accumulatedLosses: number;
  sequencePnL: number;
  balanceBefore: number;
  balanceAfter: number;
  skippedReason?: string;
};

export type SequenceRecord = {
  seqId: number;
  startBalance: number;
  endBalance: number;
  baseStake: number;
  attempts: number;
  outcome: "SUCCESS" | "FAILED" | "BLOWN";
  sequencePnL: number;
  startIso: string;
  endIso: string;
};

export type BankruptcyInfo = {
  blown: true;
  date: string;
  seqId: number;
  balanceBeforeSequence: number;
  lossesInSequence: number;
  requiredNextStake: number;
  availableBalance: number;
  tradesBeforeFailure: number;
  daysSurvived: number;
};

export type SimConfig = {
  name: string;
  maxRecoveryAttempts: number | null; // null = unlimited until insufficient funds
  startingBalance?: number;
};

export type SimResult = {
  config: SimConfig;
  startingBalance: number;
  finalBalance: number;
  netProfit: number;
  returnPct: number;
  maxBalance: number;
  minBalance: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  largestStake: number;
  largestStakePct: number;
  longestLosingStreak: number;
  longestWinningStreak: number;
  signalsSeen: number;
  signalsTraded: number;
  signalsSkipped: number;
  wins: number;
  losses: number;
  ties: number;
  individualWr: number;
  sequences: number;
  successfulSequences: number;
  failedSequences: number;
  sequenceSuccessRate: number;
  fullSequenceFailureRate: number;
  avgProfitSuccessfulSeq: number;
  avgLossFailedSeq: number;
  profitFactor: number;
  blown: boolean;
  bankruptcy?: BankruptcyInfo;
  trades: TradeRecord[];
  sequencesLog: SequenceRecord[];
  equityCurve: Array<{
    timestamp: string;
    balance: number;
    equity: number;
    seqId: number;
    stake: number;
    drawdownPct: number;
  }>;
};

function roundStake(x: number): number {
  return Math.round(x * 100) / 100;
}

function attemptLabel(n: number): AttemptLabel {
  return n === 0 ? "Base" : (`MG${n}` as AttemptLabel);
}

function recoveryStake(accumulatedLosses: number, targetProfit: number, payout: number): number {
  return roundStake((accumulatedLosses + targetProfit) / payout);
}

export function theoreticalEscalation(baseStake: number, payout: number, accountCap: number) {
  const rows: Array<{ attempt: string; stake: number; cumulativeRisk: number }> = [];
  let accumulated = 0;
  let stake = baseStake;
  const targetProfit = baseStake * payout;
  for (let i = 0; i < 20; i++) {
    const label = i === 0 ? "Base" : `MG${i}`;
    accumulated += stake;
    rows.push({ attempt: label, stake, cumulativeRisk: roundStake(accumulated) });
    if (stake > accountCap) break;
    stake = recoveryStake(accumulated, targetProfit, payout);
  }
  return rows;
}

export function simulateAccount(
  signals: MasterSignal[],
  config: SimConfig,
  periodStartMs: number,
): SimResult {
  const startingBalance = config.startingBalance ?? STARTING_BALANCE;
  let balance = startingBalance;
  let busyUntilMs = 0;
  let inRecovery = false;
  let seqId = 0;
  let attempt = 0;
  let baseStake = 0;
  let targetProfit = 0;
  let accumulatedLosses = 0;
  let seqStartBalance = startingBalance;
  let seqStartIso = "";
  let seqAccumPnL = 0;

  let maxBalance = startingBalance;
  let minBalance = startingBalance;
  let peak = startingBalance;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let largestStake = 0;
  let largestStakePct = 0;

  let wins = 0;
  let losses = 0;
  let ties = 0;
  let signalsSeen = signals.length;
  let signalsTraded = 0;
  let signalsSkipped = 0;

  let successfulSequences = 0;
  let failedSequences = 0;
  const sequencesLog: SequenceRecord[] = [];
  const trades: TradeRecord[] = [];
  const equityCurve: SimResult["equityCurve"] = [];

  let currentLosingStreak = 0;
  let longestLosingStreak = 0;
  let currentWinningStreak = 0;
  let longestWinningStreak = 0;

  let blown = false;
  let bankruptcy: BankruptcyInfo | undefined;
  let tradesBeforeFailure = 0;

  const pushEquity = (iso: string, seq: number, stake: number) => {
    peak = Math.max(peak, balance);
    const ddUsd = peak - balance;
    const ddPct = peak > 0 ? ddUsd / peak : 0;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, ddUsd);
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
    maxBalance = Math.max(maxBalance, balance);
    minBalance = Math.min(minBalance, balance);
    equityCurve.push({
      timestamp: iso,
      balance: roundStake(balance),
      equity: roundStake(balance),
      seqId: seq,
      stake,
      drawdownPct: roundStake(ddPct * 10000) / 10000,
    });
  };

  const closeSequence = (outcome: SequenceRecord["outcome"], endIso: string) => {
    sequencesLog.push({
      seqId,
      startBalance: seqStartBalance,
      endBalance: balance,
      baseStake,
      attempts: attempt + 1,
      outcome,
      sequencePnL: roundStake(balance - seqStartBalance),
      startIso: seqStartIso,
      endIso,
    });
    if (outcome === "SUCCESS") successfulSequences++;
    else failedSequences++;
    inRecovery = false;
    attempt = 0;
    accumulatedLosses = 0;
    seqAccumPnL = 0;
  };

  for (const sig of signals) {
    if (blown) break;

    if (sig.entryMs < busyUntilMs) {
      signalsSkipped++;
      continue;
    }

    let stake: number;
    if (!inRecovery) {
      seqId++;
      attempt = 0;
      baseStake = roundStake(Math.max(MIN_STAKE, balance * STAKE_FRACTION));
      if (baseStake > balance) {
        blown = true;
        bankruptcy = {
          blown: true,
          date: sig.entryIso,
          seqId,
          balanceBeforeSequence: seqStartBalance,
          lossesInSequence: accumulatedLosses,
          requiredNextStake: baseStake,
          availableBalance: balance,
          tradesBeforeFailure,
          daysSurvived: (Date.parse(sig.entryIso) - periodStartMs) / 86_400_000,
        };
        break;
      }
      targetProfit = roundStake(baseStake * PAYOUT);
      accumulatedLosses = 0;
      seqStartBalance = balance;
      seqStartIso = sig.entryIso;
      seqAccumPnL = 0;
      stake = baseStake;
    } else {
      attempt++;
      stake = recoveryStake(accumulatedLosses, targetProfit, PAYOUT);
      if (stake > balance) {
        blown = true;
        bankruptcy = {
          blown: true,
          date: sig.entryIso,
          seqId,
          balanceBeforeSequence: seqStartBalance,
          lossesInSequence: accumulatedLosses,
          requiredNextStake: stake,
          availableBalance: balance,
          tradesBeforeFailure,
          daysSurvived: (Date.parse(sig.entryIso) - periodStartMs) / 86_400_000,
        };
        closeSequence("BLOWN", sig.entryIso);
        break;
      }
    }

    largestStake = Math.max(largestStake, stake);
    largestStakePct = Math.max(largestStakePct, stake / Math.max(seqStartBalance, MIN_STAKE));

    const balanceBefore = balance;
    balance = roundStake(balance - stake);
    busyUntilMs = sig.expiryMs;
    signalsTraded++;
    tradesBeforeFailure++;

    const recordAttempt = attempt;
    const recordLabel = attemptLabel(recordAttempt);

    let pnl = 0;
    if (sig.result === "TIE") {
      ties++;
      balance = roundStake(balance + stake);
      pnl = 0;
      trades.push({
        seqId,
        attempt: recordAttempt,
        attemptLabel: recordLabel,
        pair: sig.pair,
        direction: sig.direction,
        entryIso: sig.entryIso,
        expiryIso: sig.expiryIso,
        entryPrice: sig.entryPrice,
        expiryPrice: sig.expiryPrice,
        result: sig.result,
        stake,
        payout: PAYOUT,
        pnl,
        accumulatedLosses,
        sequencePnL: roundStake(balance - seqStartBalance),
        balanceBefore,
        balanceAfter: balance,
      });
      pushEquity(sig.expiryIso, seqId, stake);
      continue;
    }

    if (sig.result === "WIN") {
      wins++;
      pnl = roundStake(stake * PAYOUT);
      balance = roundStake(balance + stake + pnl);
      currentWinningStreak++;
      currentLosingStreak = 0;
      longestWinningStreak = Math.max(longestWinningStreak, currentWinningStreak);
      trades.push({
        seqId,
        attempt: recordAttempt,
        attemptLabel: recordLabel,
        pair: sig.pair,
        direction: sig.direction,
        entryIso: sig.entryIso,
        expiryIso: sig.expiryIso,
        entryPrice: sig.entryPrice,
        expiryPrice: sig.expiryPrice,
        result: sig.result,
        stake,
        payout: PAYOUT,
        pnl,
        accumulatedLosses,
        sequencePnL: roundStake(balance - seqStartBalance),
        balanceBefore,
        balanceAfter: balance,
      });
      pushEquity(sig.expiryIso, seqId, stake);
      closeSequence("SUCCESS", sig.expiryIso);
      continue;
    }

    losses++;
    pnl = -stake;
    accumulatedLosses = roundStake(accumulatedLosses + stake);
    currentLosingStreak++;
    currentWinningStreak = 0;
    longestLosingStreak = Math.max(longestLosingStreak, currentLosingStreak);

    const maxAttempts = config.maxRecoveryAttempts;
    if (maxAttempts !== null && attempt >= maxAttempts) {
      closeSequence("FAILED", sig.expiryIso);
    } else {
      inRecovery = true;
    }

    trades.push({
      seqId,
      attempt: recordAttempt,
      attemptLabel: recordLabel,
      pair: sig.pair,
      direction: sig.direction,
      entryIso: sig.entryIso,
      expiryIso: sig.expiryIso,
      entryPrice: sig.entryPrice,
      expiryPrice: sig.expiryPrice,
      result: sig.result,
      stake,
      payout: PAYOUT,
      pnl,
      accumulatedLosses,
      sequencePnL: roundStake(balance - seqStartBalance),
      balanceBefore,
      balanceAfter: balance,
    });
    pushEquity(sig.expiryIso, seqId, stake);
  }

  const sequences = successfulSequences + failedSequences;
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const decided = wins + losses;
  const successfulPnls = sequencesLog.filter((s) => s.outcome === "SUCCESS").map((s) => s.sequencePnL);
  const failedPnls = sequencesLog.filter((s) => s.outcome === "FAILED").map((s) => s.sequencePnL);

  return {
    config,
    startingBalance,
    finalBalance: roundStake(balance),
    netProfit: roundStake(balance - startingBalance),
    returnPct: roundStake(((balance - startingBalance) / startingBalance) * 10000) / 100,
    maxBalance: roundStake(maxBalance),
    minBalance: roundStake(minBalance),
    maxDrawdownPct: roundStake(maxDrawdownPct * 10000) / 100,
    maxDrawdownUsd: roundStake(maxDrawdownUsd),
    largestStake: roundStake(largestStake),
    largestStakePct: roundStake(largestStakePct * 10000) / 100,
    longestLosingStreak,
    longestWinningStreak,
    signalsSeen,
    signalsTraded,
    signalsSkipped,
    wins,
    losses,
    ties,
    individualWr: decided ? wins / decided : 0,
    sequences,
    successfulSequences,
    failedSequences,
    sequenceSuccessRate: sequences ? successfulSequences / sequences : 0,
    fullSequenceFailureRate: sequences ? failedSequences / sequences : 0,
    avgProfitSuccessfulSeq: successfulPnls.length
      ? roundStake(successfulPnls.reduce((a, b) => a + b, 0) / successfulPnls.length)
      : 0,
    avgLossFailedSeq: failedPnls.length
      ? roundStake(failedPnls.reduce((a, b) => a + b, 0) / failedPnls.length)
      : 0,
    profitFactor: grossLoss > 0 ? roundStake(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    blown,
    bankruptcy,
    trades,
    sequencesLog,
    equityCurve,
  };
}

export function losingStreakDistribution(trades: TradeRecord[]) {
  const decided = trades.filter((t) => t.result !== "TIE");
  const buckets = new Map<number, number>();
  let streak = 0;
  let longest = 0;
  for (const t of decided) {
    if (t.result === "LOSS") {
      streak++;
      longest = Math.max(longest, streak);
    } else {
      if (streak > 0) {
        const key = streak >= 7 ? 7 : streak;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      streak = 0;
    }
  }
  if (streak > 0) {
    const key = streak >= 7 ? 7 : streak;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    longest = Math.max(longest, streak);
  }
  return { buckets, longest };
}

export type MonteCarloSummary = {
  runs: number;
  tradeCount: number;
  wr: number;
  pctProfitable: number;
  pctBelowStart: number;
  pctBlown: number;
  medianEnding: number;
  meanEnding: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  medianMaxDrawdownPct: number;
  endings: number[];
};

function simulateMonteCarloRun(
  observedWr: number,
  sequenceCount: number,
  maxRecoveryAttempts: number | null,
): { ending: number; maxDrawdownPct: number; blown: boolean } {
  let balance = STARTING_BALANCE;
  let peak = STARTING_BALANCE;
  let maxDrawdownPct = 0;

  for (let s = 0; s < sequenceCount; s++) {
    if (balance < MIN_STAKE) return { ending: balance, maxDrawdownPct, blown: true };

    const baseStake = roundStake(Math.max(MIN_STAKE, balance * STAKE_FRACTION));
    const targetProfit = roundStake(baseStake * PAYOUT);
    let accumulatedLosses = 0;
    let attempt = 0;
    let won = false;

    while (!won) {
      let stake = attempt === 0 ? baseStake : recoveryStake(accumulatedLosses, targetProfit, PAYOUT);
      if (stake > balance) return { ending: balance, maxDrawdownPct, blown: true };

      balance = roundStake(balance - stake);
      const win = Math.random() < observedWr;
      if (win) {
        balance = roundStake(balance + stake + stake * PAYOUT);
        won = true;
      } else {
        accumulatedLosses = roundStake(accumulatedLosses + stake);
        if (maxRecoveryAttempts !== null && attempt >= maxRecoveryAttempts) break;
        attempt++;
      }

      peak = Math.max(peak, balance);
      const ddPct = peak > 0 ? (peak - balance) / peak : 0;
      maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
    }
  }

  return { ending: balance, maxDrawdownPct, blown: balance < MIN_STAKE };
}

export function runMonteCarlo(
  observedWr: number,
  sequenceCount: number,
  maxRecoveryAttempts: number | null = null,
  runs = 10_000,
): MonteCarloSummary {
  const endings: number[] = [];
  const maxDDs: number[] = [];
  let blownCount = 0;

  for (let r = 0; r < runs; r++) {
    const out = simulateMonteCarloRun(observedWr, sequenceCount, maxRecoveryAttempts);
    endings.push(out.ending);
    maxDDs.push(out.maxDrawdownPct * 100);
    if (out.blown) blownCount++;
  }

  endings.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))] ?? 0;

  return {
    runs,
    tradeCount: sequenceCount,
    wr: observedWr,
    pctProfitable: endings.filter((x) => x > STARTING_BALANCE).length / runs,
    pctBelowStart: endings.filter((x) => x < STARTING_BALANCE).length / runs,
    pctBlown: blownCount / runs,
    medianEnding: q(endings, 0.5),
    meanEnding: roundStake(endings.reduce((a, b) => a + b, 0) / runs),
    p5: q(endings, 0.05),
    p25: q(endings, 0.25),
    p75: q(endings, 0.75),
    p95: q(endings, 0.95),
    medianMaxDrawdownPct: q(maxDDs, 0.5),
    endings,
  };
}
