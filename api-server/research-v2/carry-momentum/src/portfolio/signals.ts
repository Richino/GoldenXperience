import { mean } from "../../../src/math.js";
import {
  CURRENCIES,
  MOM_HORIZONS,
  ZONES,
  type MomHorizon,
} from "../config.js";
import { splitPair, type D1Panel } from "../d1/aggregate.js";
import { pairFromCurrencies } from "../pairs.js";
import { yieldAsOf, type YieldObs } from "../yields/store.js";
import type { Currency } from "../types.js";

export type Zone = "train" | "dev" | "sealed" | "other";

export function zoneOf(iso: string): Zone {
  const t = Date.parse(iso);
  if (t >= Date.parse(ZONES.trainStart) && t <= Date.parse(ZONES.trainEnd)) return "train";
  if (t >= Date.parse(ZONES.devStart) && t <= Date.parse(ZONES.devEnd)) return "dev";
  if (t >= Date.parse(ZONES.sealedStart) && t <= Date.parse(ZONES.sealedEnd)) return "sealed";
  return "other";
}

export type CurrencyRanks = {
  date: string;
  carry: Map<Currency, number>;
  carryRank: Map<Currency, number>;
  momentum: Map<Currency, number>;
  momRank: Map<Currency, number>;
  combined: Map<Currency, number>;
  combinedRank: Map<Currency, number>;
};

function rankMap(scores: Map<Currency, number>): Map<Currency, number> {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map<Currency, number>();
  sorted.forEach(([c], i) => out.set(c, i + 1));
  return out;
}

export function carryScores(yields: YieldObs[], asOfIso: string): Map<Currency, number> {
  const m = new Map<Currency, number>();
  for (const c of CURRENCIES) {
    const v = yieldAsOf(yields, c, asOfIso);
    if (v != null) m.set(c, v);
  }
  return m;
}

/** Cross-sectional currency momentum from pair log-returns / ATR proxy. */
export function momentumScores(
  panels: Map<string, D1Panel>,
  instruments: readonly string[],
  date: string,
  lookbackDays: number,
): Map<Currency, { score: number; n: number }> {
  const acc = new Map<Currency, { sum: number; n: number }>();
  for (const c of CURRENCIES) acc.set(c, { sum: 0, n: 0 });

  for (const inst of instruments) {
    const p = panels.get(inst);
    if (!p) continue;
    const idx = p.dateIndex.get(date);
    if (idx == null || idx < lookbackDays) continue;
    const c0 = p.bars[idx - lookbackDays]!.close;
    const c1 = p.bars[idx]!.close;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const r = Math.log(c1 / c0);
    const { base, quote } = splitPair(inst);
    const b = acc.get(base)!;
    const q = acc.get(quote)!;
    b.sum += r;
    b.n += 1;
    q.sum -= r;
    q.n += 1;
  }

  const out = new Map<Currency, { score: number; n: number }>();
  for (const c of CURRENCIES) {
    const a = acc.get(c)!;
    out.set(c, { score: a.n > 0 ? a.sum / a.n : 0, n: a.n });
  }
  return out;
}

export function multiHorizonMomentum(
  panels: Map<string, D1Panel>,
  instruments: readonly string[],
  date: string,
  primary: MomHorizon = "3m",
): Map<Currency, number> {
  const horizons: MomHorizon[] = ["1m", "3m", "6m", "12m"];
  const weights: Record<MomHorizon, number> = { "1m": 0.15, "3m": 0.35, "6m": 0.3, "12m": 0.2 };
  // Emphasize primary horizon slightly
  weights[primary] += 0.1;

  const combined = new Map<Currency, number>();
  for (const c of CURRENCIES) combined.set(c, 0);

  for (const h of horizons) {
    const raw = momentumScores(panels, instruments, date, MOM_HORIZONS[h]);
    const vals = [...raw.values()].map((v) => v.score);
    const m = mean(vals);
    const sd = Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, vals.length)) || 1;
    for (const c of CURRENCIES) {
      const z = ((raw.get(c)?.score ?? 0) - m) / sd;
      combined.set(c, (combined.get(c) ?? 0) + weights[h] * z);
    }
  }
  return combined;
}

export function buildRanks(args: {
  yields: YieldObs[];
  panels: Map<string, D1Panel>;
  instruments: readonly string[];
  date: string;
  closeTime: string;
  carryWeight: number;
  momWeight: number;
  momHorizon: MomHorizon;
}): CurrencyRanks {
  const { yields, panels, instruments, date, closeTime, carryWeight, momWeight, momHorizon } = args;
  const carry = carryScores(yields, closeTime);
  const mom = multiHorizonMomentum(panels, instruments, date, momHorizon);

  const carryRank = rankMap(carry);
  const momRank = rankMap(mom);

  const combined = new Map<Currency, number>();
  for (const c of CURRENCIES) {
    // Lower rank = stronger; invert to score (8 - rank)
    const cr = 9 - (carryRank.get(c) ?? 8);
    const mr = 9 - (momRank.get(c) ?? 8);
    combined.set(c, carryWeight * cr + momWeight * mr);
  }
  const combinedRank = rankMap(combined);

  return { date, carry, carryRank, momentum: mom, momRank, combined, combinedRank };
}

export type Position = {
  instrument: string;
  direction: "long" | "short";
  weight: number;
  strong: Currency;
  weak: Currency;
};

/** Build balanced top-K vs bottom-K portfolio with exposure cap. */
export function selectPortfolio(args: {
  ranks: CurrencyRanks;
  k: number;
  universe: readonly string[];
  signal: "carry" | "momentum" | "combined";
  maxPerCurrency: number;
}): Position[] {
  const { ranks, k, universe, signal, maxPerCurrency } = args;
  const rankMapUse =
    signal === "carry" ? ranks.carryRank : signal === "momentum" ? ranks.momRank : ranks.combinedRank;

  const sorted = [...CURRENCIES].sort((a, b) => (rankMapUse.get(a) ?? 99) - (rankMapUse.get(b) ?? 99));
  const tops = sorted.slice(0, k);
  const bots = sorted.slice(-k);

  type Cand = Position & { score: number };
  const cands: Cand[] = [];
  for (const strong of tops) {
    for (const weak of bots) {
      const mapped = pairFromCurrencies(strong, weak, universe);
      if (!mapped) continue;
      const score = (rankMapUse.get(weak) ?? 0) - (rankMapUse.get(strong) ?? 0);
      cands.push({
        instrument: mapped.instrument,
        direction: mapped.direction,
        weight: 0,
        strong,
        weak,
        score,
      });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  const picked: Position[] = [];
  const exposure = new Map<Currency, number>();

  const bump = (pos: Position, sign: number) => {
    const { base, quote } = splitPair(pos.instrument);
    if (pos.direction === "long") {
      exposure.set(base, (exposure.get(base) ?? 0) + sign);
      exposure.set(quote, (exposure.get(quote) ?? 0) - sign);
    } else {
      exposure.set(base, (exposure.get(base) ?? 0) - sign);
      exposure.set(quote, (exposure.get(quote) ?? 0) + sign);
    }
  };

  for (const c of cands) {
    if (picked.length >= k) break;
    bump(c, 1);
    let ok = true;
    for (const v of exposure.values()) {
      if (Math.abs(v) > maxPerCurrency) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      bump(c, -1);
      continue;
    }
    picked.push({ ...c, weight: 1 / k });
  }

  const w = picked.length ? 1 / picked.length : 0;
  return picked.map((p) => ({ ...p, weight: w }));
}

/** Signal diagnostic: bucket pairs by carry differential, measure forward returns. */
export function carryBucketTest(args: {
  panels: Map<string, D1Panel>;
  instruments: readonly string[];
  yields: YieldObs[];
  dates: string[];
  zone: Zone;
  forwardDays: number;
}): { buckets: Record<string, { n: number; avgRet: number }>; monotonic: "YES" | "PARTIAL" | "NO" } {
  const { panels, instruments, yields, dates, zone, forwardDays } = args;
  const diffs: Array<{ diff: number; ret: number }> = [];

  for (const date of dates) {
    const p0 = panels.get(instruments[0]!);
    if (!p0) continue;
    const idx = p0.dateIndex.get(date);
    if (idx == null) continue;
    const bar = p0.bars[idx]!;
    if (zoneOf(bar.closeTime) !== zone) continue;

    const rates = carryScores(yields, bar.closeTime);
    for (const inst of instruments) {
      const panel = panels.get(inst);
      if (!panel) continue;
      const i = panel.dateIndex.get(date);
      const j = i != null ? i + forwardDays : null;
      if (i == null || j == null || j >= panel.bars.length) continue;
      const b0 = panel.bars[i]!;
      const b1 = panel.bars[j]!;
      if (b0.bidClose == null || b0.askClose == null || b1.bidClose == null) continue;
      const { base, quote } = splitPair(inst);
      const br = rates.get(base);
      const qr = rates.get(quote);
      if (br == null || qr == null) continue;
      const diff = br - qr;
      const longRet = (b1.bidClose - b0.askClose) / b0.askClose;
      diffs.push({ diff, ret: longRet });
    }
  }

  if (diffs.length < 30) return { buckets: {}, monotonic: "NO" };
  diffs.sort((a, b) => a.diff - b.diff);
  const n = diffs.length;
  const q = Math.floor(n / 5);
  const labels = ["lowest", "low", "neutral", "high", "highest"];
  const buckets: Record<string, { n: number; avgRet: number }> = {};
  const means: number[] = [];
  for (let b = 0; b < 5; b++) {
    const slice = diffs.slice(b * q, b === 4 ? n : (b + 1) * q);
    const avgRet = mean(slice.map((s) => s.ret));
    buckets[labels[b]!] = { n: slice.length, avgRet };
    means.push(avgRet);
  }
  let mono = 0;
  for (let i = 1; i < means.length; i++) {
    if (means[i]! >= means[i - 1]! - 0.0001) mono++;
  }
  const monotonic = mono >= 4 ? "YES" : mono >= 2 ? "PARTIAL" : "NO";
  return { buckets, monotonic };
}

export function momentumGradientTest(args: {
  panels: Map<string, D1Panel>;
  instruments: readonly string[];
  dates: string[];
  zone: Zone;
  momHorizon: MomHorizon;
  forwardDays: number;
}): { topRet: number; midRet: number; botRet: number; gradient: "YES" | "PARTIAL" | "NO" } {
  const { panels, instruments, dates, zone, momHorizon, forwardDays } = args;
  const topRets: number[] = [];
  const botRets: number[] = [];

  for (const date of dates) {
    const p0 = panels.get(instruments[0]!);
    if (!p0) continue;
    const idx = p0.dateIndex.get(date);
    if (idx == null) continue;
    const bar = p0.bars[idx]!;
    if (zoneOf(bar.closeTime) !== zone) continue;

    const mom = multiHorizonMomentum(panels, instruments, date, momHorizon);
    const sorted = [...CURRENCIES].sort((a, b) => (mom.get(b) ?? 0) - (mom.get(a) ?? 0));
    const top2 = new Set(sorted.slice(0, 2));
    const bot2 = new Set(sorted.slice(-2));

    for (const inst of instruments) {
      const panel = panels.get(inst);
      if (!panel) continue;
      const i = panel.dateIndex.get(date);
      const j = i != null ? i + forwardDays : null;
      if (i == null || j == null || j >= panel.bars.length) continue;
      const b0 = panel.bars[i]!;
      const b1 = panel.bars[j]!;
      if (b0.bidClose == null || b0.askClose == null || b1.bidClose == null) continue;
      const { base, quote } = splitPair(inst);
      const longRet = (b1.bidClose - b0.askClose) / b0.askClose;
      if (top2.has(base) && bot2.has(quote)) topRets.push(longRet);
      if (bot2.has(base) && top2.has(quote)) botRets.push(-longRet);
    }
  }

  const topRet = mean(topRets);
  const botRet = mean(botRets);
  const midRet = (topRet + botRet) / 2;
  const gradient = topRet > botRet + 0.001 ? "YES" : topRet > botRet ? "PARTIAL" : "NO";
  return { topRet, midRet, botRet, gradient };
}
