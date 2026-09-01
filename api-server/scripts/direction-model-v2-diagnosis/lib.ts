/**
 * DIRECTION_MODEL_DIAGNOSIS_V2 — diagnostic library.
 *
 * DIAGNOSIS ONLY. Reuses the frozen MOVE_MODEL and the existing DIRECTION_MODEL
 * dataset/features/leakage-protections/walk-forward — nothing there is modified,
 * retrained for optimization, or replaced. This module only ADDS:
 *   - DST-aware session classification,
 *   - per-record market-state fields (current direction, trend/momentum strength,
 *     vol regime & expansion, breakout/level geometry),
 *   - continuation/reversal + breakout-side + level-reaction labels,
 *   - a small M5-based 5m extension (flagged: beyond the frozen MOVE_MODEL, which
 *     only covers 15m+).
 */
import {
  DIR_FEATURES, FROZEN_MOVE_THRESHOLD, HORIZONS, prepareSeries,
  type Bar, type DirRecord, type News,
} from "../direction-model-v1/lib.js";

export { DIR_FEATURES, FROZEN_MOVE_THRESHOLD, HORIZONS };
export type { Bar, DirRecord };

const PIP = 0.0001;
const barMs = 15 * 60_000;

// ---------------------------------------------------------------------------
// DST-aware session classification (economic sessions in UTC shift with DST).
// EU DST: last Sun Mar 01:00 UTC .. last Sun Oct 01:00 UTC.
// US DST: 2nd Sun Mar 07:00 UTC .. 1st Sun Nov 06:00 UTC.
// London 08:00-16:00 local; New York 08:00-17:00 local.
// ---------------------------------------------------------------------------
function lastSundayUTC(year: number, monthIdx: number) { const d = new Date(Date.UTC(year, monthIdx + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); }
function nthSundayUTC(year: number, monthIdx: number, n: number) { const d = new Date(Date.UTC(year, monthIdx, 1)); const first = (7 - d.getUTCDay()) % 7; d.setUTCDate(1 + first + (n - 1) * 7); return d.getTime(); }
function isEUDST(t: number) { const y = new Date(t).getUTCFullYear(); return t >= lastSundayUTC(y, 2) + 3_600_000 && t < lastSundayUTC(y, 9) + 3_600_000; }
function isUSDST(t: number) { const y = new Date(t).getUTCFullYear(); return t >= nthSundayUTC(y, 2, 2) + 7 * 3_600_000 && t < nthSundayUTC(y, 10, 1) + 6 * 3_600_000; }
export function classifySessionDST(t: number): "ASIA" | "LONDON" | "NEW_YORK" | "OVERLAP" {
  const londonHour = new Date(t + (isEUDST(t) ? 3_600_000 : 0)).getUTCHours();
  const nyHour = new Date(t - (isUSDST(t) ? 4 : 5) * 3_600_000).getUTCHours();
  const inLondon = londonHour >= 8 && londonHour < 16;
  const inNY = nyHour >= 8 && nyHour < 17;
  if (inLondon && inNY) return "OVERLAP";
  if (inLondon) return "LONDON";
  if (inNY) return "NEW_YORK";
  return "ASIA";
}

// ---------------------------------------------------------------------------
// Per-record market-state + continuation/breakout/level geometry.
// ---------------------------------------------------------------------------
function rangeStats(bars: Bar[], i: number, look: number, includeCurrent = true) {
  let hi = -Infinity, lo = Infinity; const end = includeCurrent ? i : i - 1;
  for (let c = end - look + 1; c <= end; c += 1) { hi = Math.max(hi, bars[c]!.high); lo = Math.min(lo, bars[c]!.low); }
  return { high: hi, low: lo, width: hi - lo };
}
const iRet4 = DIR_FEATURES.findIndex((f) => f.name === "ret4");
const iTrend = DIR_FEATURES.findIndex((f) => f.name === "ema20_ema50");
const iAtrExp = DIR_FEATURES.findIndex((f) => f.name === "atr14_56");

export type State = {
  sessionDST: string;
  currentDir: "UP" | "DOWN" | "RANGE";
  trendState: "TRENDING_UP" | "TRENDING_DOWN" | "RANGE";
  trendStrong: boolean; momHigh: boolean;
  volTercile: "LOW_VOL" | "MID_VOL" | "HIGH_VOL";
  volState: "VOL_EXPANSION" | "VOL_COMPRESSION" | "VOL_NEUTRAL";
  nearBoundary: boolean; boundaryUpper: boolean; // 20-bar range edge
  nearLevel: boolean; levelUpper: boolean;       // 64-bar S/R
  // per horizon: continuation(1)/reversal(0)/NA(-1); breakoutUp(1)/down(0); levelBreak(1)/reject(0)
  continuation: number[]; breakoutUp: number[]; levelBreak: number[];
};

export function buildStates(bars: Bar[], records: DirRecord[], momHighThr: number, trendStrongThr: number, volLoQ: number, volHiQ: number): State[] {
  const tIndex = new Map<number, number>(); for (let i = 0; i < bars.length; i += 1) tIndex.set(bars[i]!.t, i);
  const s = prepareSeries(bars);
  return records.map((r) => {
    const i = tIndex.get(r.t)!; const atr = s.atr14[i]!; const close = bars[i]!.close;
    const ret4 = r.dirX[iRet4]!; const trendMag = r.dirX[iTrend]!; const atrExp = r.dirX[iAtrExp]!;
    const currentDir = ret4 > 0.4 ? "UP" : ret4 < -0.4 ? "DOWN" : "RANGE";
    const trendState = trendMag > 0.3 ? "TRENDING_UP" : trendMag < -0.3 ? "TRENDING_DOWN" : "RANGE";
    const r20 = rangeStats(bars, i, 20); const r64 = rangeStats(bars, i, 64);
    const dHi20 = Math.abs(close - r20.high) / atr, dLo20 = Math.abs(close - r20.low) / atr;
    const dHi64 = Math.abs(close - r64.high) / atr, dLo64 = Math.abs(close - r64.low) / atr;
    const nearBoundary = Math.min(dHi20, dLo20) < 0.30; const boundaryUpper = dHi20 <= dLo20;
    const nearLevel = Math.min(dHi64, dLo64) < 0.30; const levelUpper = dHi64 <= dLo64;
    const continuation: number[] = [], breakoutUp: number[] = [], levelBreak: number[] = [];
    for (let h = 0; h < HORIZONS.length; h += 1) {
      const futUp = r.upLabel[h]!;
      continuation.push(currentDir === "RANGE" ? -1 : ((currentDir === "UP") === futUp ? 1 : 0));
      breakoutUp.push(futUp ? 1 : 0);
      // level break: at resistance (64-bar upper) break=UP move; at support (64-bar lower) break=DOWN move.
      // NOTE: must use the 64-bar level side (levelUpper), matching the nearLevel eligibility — not the 20-bar boundary side.
      levelBreak.push((levelUpper ? futUp : !futUp) ? 1 : 0);
    }
    return {
      sessionDST: classifySessionDST(r.t), currentDir, trendState,
      trendStrong: Math.abs(trendMag) >= trendStrongThr, momHigh: Math.abs(ret4) >= momHighThr,
      volTercile: r.volRatio < volLoQ ? "LOW_VOL" : r.volRatio < volHiQ ? "MID_VOL" : "HIGH_VOL",
      volState: atrExp > 1.05 ? "VOL_EXPANSION" : atrExp < 0.95 ? "VOL_COMPRESSION" : "VOL_NEUTRAL",
      nearBoundary, boundaryUpper, nearLevel, levelUpper, continuation, breakoutUp, levelBreak,
    };
  });
}

// ---------------------------------------------------------------------------
// M5-based 5m extension (beyond frozen MOVE_MODEL; same methodology on M5).
// ---------------------------------------------------------------------------
export type M5Record = { t: number; x: number[]; up: boolean; moveGT: boolean; currentDir: "UP" | "DOWN" | "RANGE"; session: string; volRatio: number; trendState: string };
export const M5_FEATURES = ["close_ema20", "close_ema50", "ema20_ema50", "ema20_slope4", "ret1", "ret3", "ret6", "ret12", "consecutive", "range_pos20", "dist_hi12", "dist_lo12", "atr14_56", "range_atr", "body_signed", "hour_sin", "hour_cos", "spread_atr"];
export function buildM5Records(m5: Bar[], from: number, to: number, threshold: number): M5Record[] {
  const s = prepareSeries(m5); const out: M5Record[] = [];
  const WARM = 240;
  for (let i = WARM; i < m5.length - 1; i += 1) {
    const t = m5[i]!.t; if (t < from || t >= to) continue;
    const atr = s.atr14[i]!; if (!Number.isFinite(atr) || atr <= 0) continue;
    const bar = m5[i]!; const close = bar.close;
    if (m5[i + 1]!.t - t > 5 * 60_000 * 1.5) continue; // contiguous next bar
    let consec = 0; const ld = Math.sign(s.closes[i]! - s.closes[i - 1]!);
    for (let c = i; c > i - 8; c -= 1) { const d = Math.sign(s.closes[c]! - s.closes[c - 1]!); if (!d || d !== ld) break; consec += d; }
    const r20 = rangeStats(m5, i, 20); const prior12 = rangeStats(m5, i, 12, false);
    const body = bar.close - bar.open; const spread = m5[i + 1]!.askOpen - m5[i + 1]!.bidOpen;
    const date = new Date(t); const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
    const ret6 = (s.closes[i]! - s.closes[i - 6]!) / atr;
    const x = [
      (close - s.ema20[i]!) / atr, (close - s.ema50[i]!) / atr, (s.ema20[i]! - s.ema50[i]!) / atr, (s.ema20[i]! - s.ema20[i - 4]!) / atr,
      (s.closes[i]! - s.closes[i - 1]!) / atr, (s.closes[i]! - s.closes[i - 3]!) / atr, ret6, (s.closes[i]! - s.closes[i - 12]!) / atr, consec / 8,
      r20.width ? 2 * (close - r20.low) / r20.width - 1 : 0, (close - prior12.high) / atr, (close - prior12.low) / atr,
      atr / s.atr56[i]!, (bar.high - bar.low) / atr, body / atr, Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24), spread / atr,
    ];
    if (!x.every(Number.isFinite)) continue;
    const maxHigh = m5[i + 1]!.high, minLow = m5[i + 1]!.low; // next 1 M5 bar = 5m
    const up = (maxHigh - close) >= (close - minLow);
    const excursion = Math.max(maxHigh - close, close - minLow);
    out.push({
      t, x, up, moveGT: excursion / atr >= threshold,
      currentDir: ret6 > 0.4 ? "UP" : ret6 < -0.4 ? "DOWN" : "RANGE",
      session: classifySessionDST(t), volRatio: atr / s.atr56[i]!,
      trendState: (s.ema20[i]! - s.ema50[i]!) / atr > 0.3 ? "TRENDING_UP" : (s.ema20[i]! - s.ema50[i]!) / atr < -0.3 ? "TRENDING_DOWN" : "RANGE",
    });
  }
  return out;
}

export const round = (v: unknown): unknown => typeof v === "number" ? (Number.isFinite(v) ? Number(v.toFixed(6)) : null) : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
export const csv = (rows: Record<string, unknown>[]) => {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [keys.map(q).join(","), ...rows.map((r) => keys.map((k) => q(r[k])).join(","))].join("\n") + "\n";
};
export { PIP, barMs };
