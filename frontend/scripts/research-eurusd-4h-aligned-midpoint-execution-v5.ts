/**
 * EUR/USD — 4H ALIGNED MIDPOINT EXECUTION TEST V5
 * OANDA BID/ASK — IMMEDIATE vs M5 RECLAIM only.
 *
 * RESEARCH ONLY. No new entry search / no optimization.
 */
import fs from "node:fs";
import path from "node:path";
import type { MajorInstrument } from "../src/types/forex";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const M1_PATH = path.join(PAD, "eurusd-m1-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const PIP = pipSizeFor(INSTRUMENT);
const BLOCK = 16;
const BLOCK_MS = 4 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
const UTC_HOURS = [0, 4, 8, 12, 16, 20] as const;
const EXPECT_N = 564;
const EXPECT_HIT = 70.7;
const EXPECT_RECLAIM = 454;
const STOPS = [5, 7.5, 10, 12.5, 15, 20, 25] as const;

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC };
type Side = "LONG" | "SHORT";
type Outcome = "win" | "loss" | "timeout" | "ambig" | "invalid";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pad = (xs: Array<string | number>, widths: number[]) =>
  xs.map((x, i) => String(x).padStart(widths[i] ?? 10)).join("");

function isUtcBlockStart(ms: number): boolean {
  const d = new Date(ms);
  return (
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    (UTC_HOURS as readonly number[]).includes(d.getUTCHours())
  );
}
function lb(msArr: Float64Array, len: number, target: number): number {
  let lo = 0,
    hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msArr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

console.error("V5 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n15 = raw.length;
const t15 = new Float64Array(n15);
const o15 = new Float64Array(n15);
const h15 = new Float64Array(n15);
const l15 = new Float64Array(n15);
const c15 = new Float64Array(n15);
for (let i = 0; i < n15; i++) {
  const m = raw[i]!.mid;
  t15[i] = Date.parse(raw[i]!.time);
  o15[i] = m.open;
  h15[i] = m.high;
  l15[i] = m.low;
  c15[i] = m.close;
}

console.error("V5 loading M1 BID/ASK...");
const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const t1 = new Float64Array(M1);
const bh = new Float64Array(M1),
  bl = new Float64Array(M1),
  ah = new Float64Array(M1),
  al = new Float64Array(M1),
  bc = new Float64Array(M1),
  ac = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  t1[i] = Date.parse(r[0]);
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
}
(m1raw as unknown as { length: number }).length = 0;

const midH = (i: number) => (bh[i]! + ah[i]!) / 2;
const midL = (i: number) => (bl[i]! + al[i]!) / 2;
const midC = (i: number) => (bc[i]! + ac[i]!) / 2;

interface Setup {
  year: number;
  side: Side;
  mid: number;
  openMid: number;
  distMid: number;
  m1Start: number;
  m1End: number;
  midHitBehavioral: boolean; // mid H/L through frozen mid (V4 parity)
  reclaimI: number | null; // M1 index of M5 close that reclaims
}

const setups: Setup[] = [];

for (let i = 0; i < n15; i++) {
  if (!isUtcBlockStart(t15[i]!)) continue;
  if (i < BLOCK || i + BLOCK > n15) continue;
  const trade0 = i;
  const prev0 = trade0 - BLOCK;
  const trade1 = trade0 + BLOCK - 1;

  let gap = false;
  for (let j = prev0 + 1; j <= trade1; j++) {
    if (Math.abs(t15[j]! - t15[j - 1]! - BAR_MS) > 1000) {
      gap = true;
      break;
    }
  }
  if (gap) continue;
  if (Math.abs(t15[prev0]! - (t15[trade0]! - BLOCK_MS)) > 1000) continue;

  let support = Infinity,
    resistance = -Infinity;
  for (let j = prev0; j < trade0; j++) {
    support = Math.min(support, l15[j]!);
    resistance = Math.max(resistance, h15[j]!);
  }
  const range = resistance - support;
  if (!(range > 0)) continue;
  const mid = support + range * 0.5;
  const prevOpen = o15[prev0]!;
  const prevClose = c15[trade0 - 1]!;
  const newOpen = o15[trade0]!;
  const dist = Math.abs(newOpen - mid) / PIP;
  if (!(dist > 5 && dist <= 10)) continue;

  const move = prevClose - prevOpen;
  if (!(move > 0 || move < 0)) continue;
  const trendBull = move > 0;
  const below = newOpen < mid;
  const above = newOpen > mid;
  const aligned = (trendBull && below) || (!trendBull && above);
  if (!aligned) continue;

  let m1Start = lb(t1, M1, t15[trade0]!);
  while (m1Start < M1 && t1[m1Start]! < t15[trade0]! - 500) m1Start++;
  if (m1Start >= M1) continue;
  const endMs = t15[trade0]! + BLOCK_MS;
  let m1End = lb(t1, M1, endMs) - 1;
  if (m1End < m1Start || m1End - m1Start + 1 < 30) continue;

  const side: Side = below ? "LONG" : "SHORT";

  let midHitBehavioral = false;
  for (let k = m1Start; k <= m1End; k++) {
    if (midL(k) <= mid && midH(k) >= mid) {
      midHitBehavioral = true;
      break;
    }
  }

  // RECLAIM_M5 — exact V4: MAE>=1p from open, then 1 completed M5 close through open
  let reclaimI: number | null = null;
  {
    const len = m1End - m1Start + 1;
    const maeSoFar = new Array<number>(len).fill(0);
    let mae = 0;
    for (let k = m1Start; k <= m1End; k++) {
      const off = k - m1Start;
      if (side === "LONG") mae = Math.max(mae, Math.max(0, newOpen - midL(k)) / PIP);
      else mae = Math.max(mae, Math.max(0, midH(k) - newOpen) / PIP);
      maeSoFar[off] = mae;
    }
    let startOff: number | null = null;
    for (let off = 0; off < len; off++) {
      if (maeSoFar[off]! >= 1) {
        startOff = off;
        break;
      }
    }
    if (startOff !== null) {
      // M5 aggregation like V4
      let lastBucket = Math.floor(t1[m1Start]! / (5 * 60_000));
      let bStart = m1Start;
      let bo = m1Start > 0 ? midC(m1Start - 1) : midC(m1Start);
      let bh_ = midH(m1Start);
      let bl_ = midL(m1Start);
      for (let k = m1Start + 1; k <= m1End; k++) {
        const bucket = Math.floor(t1[k]! / (5 * 60_000));
        if (bucket !== lastBucket) {
          const end = k - 1;
          if (end - m1Start >= startOff) {
            const bc_ = midC(end);
            const through = side === "LONG" ? bc_ >= newOpen : bc_ <= newOpen;
            if (through) {
              reclaimI = end;
              break;
            }
          }
          lastBucket = bucket;
          bStart = k;
          bo = midC(end);
          bh_ = midH(k);
          bl_ = midL(k);
        } else {
          bh_ = Math.max(bh_, midH(k));
          bl_ = Math.min(bl_, midL(k));
        }
      }
    }
  }

  setups.push({
    year: new Date(t15[trade0]!).getUTCFullYear(),
    side,
    mid,
    openMid: newOpen,
    distMid: dist,
    m1Start,
    m1End,
    midHitBehavioral,
    reclaimI,
  });
}

const hitPct = pct(setups.filter((s) => s.midHitBehavioral).length, setups.length);
const reclaimN = setups.filter((s) => s.reclaimI !== null).length;
console.error(`Cohort N=${setups.length} midHit%=${f1(hitPct)} reclaimN=${reclaimN}`);
if (Math.abs(setups.length - EXPECT_N) > 15 || Math.abs(hitPct - EXPECT_HIT) > 2.5) {
  console.error("STOP cohort parity fail");
  process.exit(1);
}
if (Math.abs(reclaimN - EXPECT_RECLAIM) > 40) {
  console.error(`STOP reclaim parity fail (got ${reclaimN} expect ~${EXPECT_RECLAIM})`);
  process.exit(1);
}
console.error("PARITY PASS");

// ---------- Trade simulation ----------
interface Trade {
  entry: "IMMEDIATE" | "RECLAIM_M5";
  stop: number;
  side: Side;
  year: number;
  spread: number;
  reward: number; // executable entry → mid
  rr: number; // reward/stop
  outcome: Outcome;
  pnl: number; // pips
  R: number;
  midMode: boolean; // if true, this is MID diagnostic fill
}

function simulate(
  s: Setup,
  entryMode: "IMMEDIATE" | "RECLAIM_M5",
  stopPips: number,
  useMid: boolean,
): Trade | null {
  let entryI: number;
  let entryPx: number;
  let spread: number;

  if (entryMode === "IMMEDIATE") {
    entryI = s.m1Start;
    if (useMid) {
      entryPx = s.openMid;
      spread = 0;
    } else if (s.side === "LONG") {
      entryPx = ac[entryI]!; // ASK close of first bar ≈ open ask; use ASK open proxy = al? use ask at open
      // Prefer ask open ≈ previous ask close; use ac of first bar as fill proxy at bar open is imperfect.
      // Use ask low/high mid: entry at ask open = (use al of bar as conservative? Spec: LONG=ASK.
      // At block open, use ask of first M1: approximate with ac of bar after open, or ah/al average.
      // Better: ask open ≈ previous ac; for first bar use (al+ah)/2 no — use ac[entryI] of first completed? 
      // Immediate = at open. Use ask open = mid of ask range is wrong.
      // Standard: entryI first bar, LONG fill = ask open approximated as previous ask close, else ac.
      entryPx = entryI > 0 ? ac[entryI - 1]! : ac[entryI]!;
      // If we want ask at open of entryI bar: often ≈ prior close. Spread vs bid:
      const bidPx = entryI > 0 ? bc[entryI - 1]! : bc[entryI]!;
      spread = (entryPx - bidPx) / PIP;
    } else {
      entryPx = entryI > 0 ? bc[entryI - 1]! : bc[entryI]!;
      const askPx = entryI > 0 ? ac[entryI - 1]! : ac[entryI]!;
      spread = (askPx - entryPx) / PIP;
    }
  } else {
    if (s.reclaimI === null) return null;
    entryI = s.reclaimI;
    if (useMid) {
      entryPx = midC(entryI);
      spread = 0;
    } else if (s.side === "LONG") {
      entryPx = ac[entryI]!; // ASK at M5 close
      spread = (ac[entryI]! - bc[entryI]!) / PIP;
    } else {
      entryPx = bc[entryI]!;
      spread = (ac[entryI]! - bc[entryI]!) / PIP;
    }
  }

  // Executable reward to mid
  let reward: number;
  if (useMid) {
    reward = s.side === "LONG" ? (s.mid - entryPx) / PIP : (entryPx - s.mid) / PIP;
  } else if (s.side === "LONG") {
    // exit when BID reaches mid → reward = mid - entryAsk (need bid=mid)
    reward = (s.mid - entryPx) / PIP;
  } else {
    // exit when ASK reaches mid → reward = entryBid - mid
    reward = (entryPx - s.mid) / PIP;
  }

  if (!(reward > 0)) {
    return {
      entry: entryMode,
      stop: stopPips,
      side: s.side,
      year: s.year,
      spread,
      reward,
      rr: reward / stopPips,
      outcome: "invalid",
      pnl: 0,
      R: 0,
      midMode: useMid,
    };
  }

  const stopDist = stopPips * PIP;
  const stopPx = s.side === "LONG" ? entryPx - stopDist : entryPx + stopDist;

  // Walk from entryI+1 (or entryI for immediate — include remaining of entry bar)
  // For reclaim, enter at close of entryI so path starts entryI+1
  // For immediate at open, path includes entryI bar
  const pathStart = entryMode === "IMMEDIATE" ? entryI : entryI + 1;

  let outcome: Outcome = "timeout";
  let exitPx = useMid
    ? midC(s.m1End)
    : s.side === "LONG"
      ? bc[s.m1End]!
      : ac[s.m1End]!;
  let hitTp = false;
  let hitSl = false;

  for (let i = pathStart; i <= s.m1End; i++) {
    if (useMid) {
      const hi = midH(i);
      const lo = midL(i);
      const tp = s.side === "LONG" ? hi >= s.mid : lo <= s.mid;
      const sl = s.side === "LONG" ? lo <= stopPx : hi >= stopPx;
      if (tp && sl) {
        outcome = "ambig";
        exitPx = stopPx; // conservative: don't auto-win
        hitTp = true;
        hitSl = true;
        break;
      }
      if (tp) {
        outcome = "win";
        exitPx = s.mid;
        hitTp = true;
        break;
      }
      if (sl) {
        outcome = "loss";
        exitPx = stopPx;
        hitSl = true;
        break;
      }
    } else if (s.side === "LONG") {
      // TP: BID high >= mid; SL: BID low <= stop
      const tp = bh[i]! >= s.mid;
      const sl = bl[i]! <= stopPx;
      if (tp && sl) {
        outcome = "ambig";
        exitPx = stopPx;
        break;
      }
      if (tp) {
        outcome = "win";
        exitPx = s.mid; // fill at mid on bid
        break;
      }
      if (sl) {
        outcome = "loss";
        exitPx = stopPx;
        break;
      }
    } else {
      // SHORT TP: ASK low <= mid; SL: ASK high >= stop
      const tp = al[i]! <= s.mid;
      const sl = ah[i]! >= stopPx;
      if (tp && sl) {
        outcome = "ambig";
        exitPx = stopPx;
        break;
      }
      if (tp) {
        outcome = "win";
        exitPx = s.mid;
        break;
      }
      if (sl) {
        outcome = "loss";
        exitPx = stopPx;
        break;
      }
    }
  }

  if (outcome === "timeout") {
    exitPx = useMid
      ? midC(s.m1End)
      : s.side === "LONG"
        ? bc[s.m1End]!
        : ac[s.m1End]!;
  }

  const pnl =
    s.side === "LONG" ? (exitPx - entryPx) / PIP : (entryPx - exitPx) / PIP;
  // For ambig, use stop exit pnl (already stopPx)
  const R = pnl / stopPips;

  return {
    entry: entryMode,
    stop: stopPips,
    side: s.side,
    year: s.year,
    spread,
    reward,
    rr: reward / stopPips,
    outcome,
    pnl,
    R,
    midMode: useMid,
  };
}

interface Cell {
  n: number;
  wins: number;
  losses: number;
  timeouts: number;
  ambig: number;
  invalid: number;
  pnl: number[];
  R: number[];
  reward: number[];
  spread: number[];
  rr: number[];
  winPnl: number[];
  lossPnl: number[];
}
function newCell(): Cell {
  return {
    n: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    ambig: 0,
    invalid: 0,
    pnl: [],
    R: [],
    reward: [],
    spread: [],
    rr: [],
    winPnl: [],
    lossPnl: [],
  };
}
function add(c: Cell, t: Trade) {
  if (t.outcome === "invalid") {
    c.invalid++;
    return;
  }
  c.n++;
  c.pnl.push(t.pnl);
  c.R.push(t.R);
  c.reward.push(t.reward);
  c.spread.push(t.spread);
  c.rr.push(t.rr);
  if (t.outcome === "win") {
    c.wins++;
    c.winPnl.push(t.pnl);
  } else if (t.outcome === "loss") {
    c.losses++;
    c.lossPnl.push(t.pnl);
  } else if (t.outcome === "timeout") {
    c.timeouts++;
    // timeout pnl still in totals
  } else if (t.outcome === "ambig") {
    c.ambig++;
  }
}

const cells = new Map<string, Cell>();
function C(k: string): Cell {
  let c = cells.get(k);
  if (!c) {
    c = newCell();
    cells.set(k, c);
  }
  return c;
}

function key(entry: string, stop: number, extra = ""): string {
  return `${entry}|${stop}${extra ? "|" + extra : ""}`;
}

console.error("Simulating...");
const reclaimSetups = setups.filter((s) => s.reclaimI !== null);

for (const s of setups) {
  for (const stop of STOPS) {
    for (const useMid of [false, true]) {
      const tag = useMid ? "MID" : "BA";
      const imm = simulate(s, "IMMEDIATE", stop, useMid);
      if (imm) add(C(key("IMMEDIATE", stop, tag)), imm);
      if (imm && !useMid) {
        add(C(key("IMMEDIATE", stop, `BA|${s.side}`)), imm);
        add(C(key("IMMEDIATE", stop, `BA|ERA|${s.year <= 2019 ? "2013-2019" : "2020-2026"}`)), imm);
        const sb =
          imm.spread < 1
            ? "<1"
            : imm.spread < 1.25
              ? "1-1.25"
              : imm.spread < 1.5
                ? "1.25-1.5"
                : imm.spread < 2
                  ? "1.5-2"
                  : "2+";
        add(C(key("IMMEDIATE", stop, `BA|SPR|${sb}`)), imm);
        const rb =
          imm.reward <= 0
            ? "inv"
            : imm.reward <= 3
              ? "0-3"
              : imm.reward <= 5
                ? "3-5"
                : imm.reward <= 7.5
                  ? "5-7.5"
                  : imm.reward <= 10
                    ? "7.5-10"
                    : "10+";
        if (rb !== "inv") add(C(key("IMMEDIATE", stop, `BA|REW|${rb}`)), imm);
      }
    }
  }
}

for (const s of reclaimSetups) {
  for (const stop of STOPS) {
    for (const useMid of [false, true]) {
      const tag = useMid ? "MID" : "BA";
      const rec = simulate(s, "RECLAIM_M5", stop, useMid);
      if (rec) add(C(key("RECLAIM_M5", stop, tag)), rec);
      // matched: same setup immediate
      const imm = simulate(s, "IMMEDIATE", stop, useMid);
      if (imm) add(C(key("IMMEDIATE_MATCHED", stop, tag)), imm);

      if (rec && !useMid) {
        add(C(key("RECLAIM_M5", stop, `BA|${s.side}`)), rec);
        add(C(key("RECLAIM_M5", stop, `BA|ERA|${s.year <= 2019 ? "2013-2019" : "2020-2026"}`)), rec);
        const sb =
          rec.spread < 1
            ? "<1"
            : rec.spread < 1.25
              ? "1-1.25"
              : rec.spread < 1.5
                ? "1.25-1.5"
                : rec.spread < 2
                  ? "1.5-2"
                  : "2+";
        add(C(key("RECLAIM_M5", stop, `BA|SPR|${sb}`)), rec);
        const rb =
          rec.reward <= 0
            ? "inv"
            : rec.reward <= 3
              ? "0-3"
              : rec.reward <= 5
                ? "3-5"
                : rec.reward <= 7.5
                  ? "5-7.5"
                  : rec.reward <= 10
                    ? "7.5-10"
                    : "10+";
        if (rb !== "inv") add(C(key("RECLAIM_M5", stop, `BA|REW|${rb}`)), rec);
      }
    }
  }
}

function pf(c: Cell): number {
  const gw = c.winPnl.reduce((s, x) => s + x, 0);
  // losses include stop losses + negative timeouts + ambig as taken
  const allLoss = c.pnl.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  if (allLoss >= 0) return gw > 0 ? Infinity : 0;
  return gw / Math.abs(allLoss);
}

function stats(c: Cell) {
  const exp = mean(c.pnl);
  const avgR = mean(c.R);
  return {
    n: c.n,
    winPct: pct(c.wins, c.n),
    lossN: c.losses,
    toPct: pct(c.timeouts, c.n),
    ambig: c.ambig,
    invalid: c.invalid,
    avgWin: mean(c.winPnl),
    avgLoss: mean(c.lossPnl),
    medPnl: median(c.pnl),
    totalPips: c.pnl.reduce((s, x) => s + x, 0),
    exp,
    pf: pf(c),
    avgR,
    medR: median(c.R),
    totalR: c.R.reduce((s, x) => s + x, 0),
    medRew: median(c.reward),
    medSpr: median(c.spread),
    meanSpr: mean(c.spread),
    p75Spr: q(c.spread, 0.75),
    p90Spr: q(c.spread, 0.9),
    medRR: median(c.rr),
    p25RR: q(c.rr, 0.25),
    p75RR: q(c.rr, 0.75),
  };
}

// fix spr/rew median
function medSprRew(c: Cell): number {
  const a: number[] = [];
  for (let i = 0; i < c.n; i++) {
    if (c.reward[i]! > 0) a.push((c.spread[i]! / c.reward[i]!) * 100);
  }
  return median(a);
}

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD — 4H ALIGNED MIDPOINT EXECUTION TEST V5 (BID/ASK)");
L.push("=".repeat(120));
L.push(`Cohort N=${setups.length} behavioral midHit%=${f1(hitPct)} (expect ${EXPECT_N}/${EXPECT_HIT}%)`);
L.push(`RECLAIM_M5 triggers N=${reclaimN} (expect ~${EXPECT_RECLAIM})`);
L.push(`PARITY = PASS`);
L.push("");

L.push("-".repeat(120));
L.push("SPREAD AT ENTRY (BID/ASK)");
L.push("-".repeat(120));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  const c = C(key(entry, 10, "BA")); // representative
  L.push(
    `  ${entry}: med=${f2(median(c.spread))} mean=${f2(mean(c.spread))} P75=${f2(q(c.spread, 0.75))} P90=${f2(q(c.spread, 0.9))}  med spread/reward%=${f1(medSprRew(c))}%`,
  );
}
L.push("");

L.push("-".repeat(120));
L.push("SECTION 18 — SUMMARY TABLE (BID/ASK)");
L.push("-".repeat(120));
L.push(
  pad(
    ["Entry", "Stop", "N", "Win%", "TO%", "MedRew", "MedSpr", "MedRR", "Exp", "AvgR", "PF"],
    [14, 6, 6, 7, 6, 8, 8, 8, 8, 8, 7],
  ),
);
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  for (const stop of STOPS) {
    const c = C(key(entry, stop, "BA"));
    const st = stats(c);
    L.push(
      pad(
        [
          entry.slice(0, 14),
          stop,
          st.n,
          f1(st.winPct),
          f1(st.toPct),
          f1(st.medRew),
          f2(st.medSpr),
          f2(st.medRR),
          f2(st.exp),
          f3(st.avgR),
          f2(st.pf),
        ],
        [14, 6, 6, 7, 6, 8, 8, 8, 8, 8, 7],
      ),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("PRIMARY DETAIL (BID/ASK)");
L.push("-".repeat(120));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  L.push(`\n  ${entry}`);
  L.push(
    pad(
      ["Stop", "N", "W", "SL", "TO", "Amb", "Inv", "Win%", "AvgW", "AvgL", "MedPL", "Tot", "Exp", "PF", "AvgR"],
      [6, 5, 5, 5, 5, 5, 5, 7, 7, 7, 7, 8, 7, 6, 7],
    ),
  );
  for (const stop of STOPS) {
    const c = C(key(entry, stop, "BA"));
    const st = stats(c);
    L.push(
      pad(
        [
          stop,
          st.n,
          c.wins,
          c.losses,
          c.timeouts,
          c.ambig,
          c.invalid,
          f1(st.winPct),
          f1(st.avgWin),
          f1(st.avgLoss),
          f1(st.medPnl),
          f0(st.totalPips),
          f2(st.exp),
          f2(st.pf),
          f3(st.avgR),
        ],
        [6, 5, 5, 5, 5, 5, 5, 7, 7, 7, 7, 8, 7, 6, 7],
      ),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("MATCHED COMPARISON (RECLAIM-trigger setups only)");
L.push("-".repeat(120));
L.push(pad(["Stop", "ImmExp", "RecExp", "ΔExp", "ImmPF", "RecPF", "ImmN", "RecN"], [6, 8, 8, 8, 8, 8, 6, 6]));
for (const stop of STOPS) {
  const imm = stats(C(key("IMMEDIATE_MATCHED", stop, "BA")));
  const rec = stats(C(key("RECLAIM_M5", stop, "BA")));
  L.push(
    pad(
      [stop, f2(imm.exp), f2(rec.exp), f2(rec.exp - imm.exp), f2(imm.pf), f2(rec.pf), imm.n, rec.n],
      [6, 8, 8, 8, 8, 8, 6, 6],
    ),
  );
}
L.push("");

L.push("-".repeat(120));
L.push("GROSS MID vs BID/ASK");
L.push("-".repeat(120));
L.push(pad(["Entry", "Stop", "MidExp", "BAExp", "Δ(cost)", "MidPF", "BAPF"], [14, 6, 8, 8, 8, 8, 8]));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  for (const stop of STOPS) {
    const mid = stats(C(key(entry, stop, "MID")));
    const ba = stats(C(key(entry, stop, "BA")));
    L.push(
      pad(
        [entry.slice(0, 14), stop, f2(mid.exp), f2(ba.exp), f2(ba.exp - mid.exp), f2(mid.pf), f2(ba.pf)],
        [14, 6, 8, 8, 8, 8, 8],
      ),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("SPREAD SENSITIVITY (stop=10)");
L.push("-".repeat(120));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  L.push(`\n  ${entry}`);
  for (const sb of ["<1", "1-1.25", "1.25-1.5", "1.5-2", "2+"]) {
    const c = C(key(entry, 10, `BA|SPR|${sb}`));
    if (c.n < 10) continue;
    const st = stats(c);
    L.push(
      `    spr ${sb}: N=${st.n} MedRew=${f1(st.medRew)} spr/rew%=${f1(medSprRew(c))} Exp=${f2(st.exp)} PF=${f2(st.pf)}`,
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("REWARD-DISTANCE BUCKETS (stop=10)");
L.push("-".repeat(120));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  L.push(`\n  ${entry}`);
  for (const rb of ["0-3", "3-5", "5-7.5", "7.5-10", "10+"]) {
    const c = C(key(entry, 10, `BA|REW|${rb}`));
    if (c.n < 10) continue;
    const st = stats(c);
    L.push(`    rew ${rb}: N=${st.n} Win%=${f1(st.winPct)} Exp=${f2(st.exp)} PF=${f2(st.pf)}`);
  }
}
L.push("");

L.push("-".repeat(120));
L.push("LONG / SHORT (stop=10 BID/ASK)");
L.push("-".repeat(120));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  for (const side of ["LONG", "SHORT"] as const) {
    const c = C(key(entry, 10, `BA|${side}`));
    const st = stats(c);
    L.push(
      `  ${entry} ${side}: N=${st.n} Exp=${f2(st.exp)} PF=${f2(st.pf)} Win%=${f1(st.winPct)} MedSpr=${f2(st.medSpr)}`,
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("ERA VALIDATION (BID/ASK)");
L.push("-".repeat(120));
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  for (const stop of [10, 15, 20] as const) {
    for (const era of ["2013-2019", "2020-2026"] as const) {
      const c = C(key(entry, stop, `BA|ERA|${era}`));
      if (c.n < 20) continue;
      const st = stats(c);
      L.push(
        `  ${entry} stop=${stop} ${era}: N=${st.n} Exp=${f2(st.exp)} PF=${f2(st.pf)} TotPips=${f0(st.totalPips)}`,
      );
    }
  }
}
L.push("");

// Find best configs
type Cand = { entry: string; stop: number; exp: number; pf: number; n: number; eraOk: boolean };
const cands: Cand[] = [];
for (const entry of ["IMMEDIATE", "RECLAIM_M5"] as const) {
  for (const stop of STOPS) {
    const st = stats(C(key(entry, stop, "BA")));
    const e1 = stats(C(key(entry, stop, "BA|ERA|2013-2019")));
    const e2 = stats(C(key(entry, stop, "BA|ERA|2020-2026")));
    const eraOk = !(e2.n >= 30 && e2.exp < -0.5 && e1.exp > 0);
    cands.push({ entry, stop, exp: st.exp, pf: st.pf, n: st.n, eraOk });
  }
}
const positive = cands.filter((c) => c.exp > 0 && c.pf > 1 && c.n >= 100);
const best = [...cands].sort((a, b) => b.exp - a.exp)[0]!;
const bestPos = positive.sort((a, b) => b.exp - a.exp)[0];

// Break-even for strongest
L.push("-".repeat(120));
L.push("BREAK-EVEN (strongest BID/ASK config by expectancy)");
L.push("-".repeat(120));
{
  const c = C(key(best.entry, best.stop, "BA"));
  const st = stats(c);
  const avgW = st.avgWin;
  const avgL = Math.abs(st.avgLoss);
  const be = avgW + avgL > 0 ? (avgL / (avgW + avgL)) * 100 : NaN;
  L.push(`  Config: ${best.entry} stop=${best.stop}`);
  L.push(`  Win%=${f1(st.winPct)} AvgWin=${f1(avgW)} AvgLoss=${f1(st.avgLoss)} BE win%≈${f1(be)}%`);
  L.push(`  Exp=${f2(st.exp)} PF=${f2(st.pf)} MedSpr=${f2(st.medSpr)} MedRew=${f1(st.medRew)} MedRR=${f2(st.medRR)}`);
  // max spread for ~0 exp: rough — if we add X to each loss/spread cost
  const mid = stats(C(key(best.entry, best.stop, "MID")));
  L.push(`  MID Exp=${f2(mid.exp)} → execution drag≈${f2(mid.exp - st.exp)} pips/trade`);
}
L.push("");

const imm10 = stats(C(key("IMMEDIATE", 10, "BA")));
const rec10 = stats(C(key("RECLAIM_M5", 10, "BA")));
const imm10m = stats(C(key("IMMEDIATE_MATCHED", 10, "BA")));
const matchDelta = rec10.exp - imm10m.exp;

let verdict: "EXECUTABLE_EDGE_FOUND" | "MARGINAL_EXECUTABLE_EDGE" | "BEHAVIOR_REAL_BUT_EXECUTION_KILLS_EDGE" | "NO_EXECUTABLE_EDGE";
const anyPosSurvive = positive.some((c) => {
  const e2 = stats(C(key(c.entry, c.stop, "BA|ERA|2020-2026")));
  return e2.n >= 30 && e2.exp > 0 && e2.pf > 1;
});
const midBest = Math.max(
  ...STOPS.map((s) => stats(C(key("IMMEDIATE", s, "MID"))).exp),
  ...STOPS.map((s) => stats(C(key("RECLAIM_M5", s, "MID"))).exp),
);
const baBest = best.exp;

if (bestPos && anyPosSurvive && bestPos.exp > 0.2) verdict = "EXECUTABLE_EDGE_FOUND";
else if (bestPos && bestPos.exp > 0) verdict = "MARGINAL_EXECUTABLE_EDGE";
else if (midBest > 0.3 && baBest <= 0) verdict = "BEHAVIOR_REAL_BUT_EXECUTION_KILLS_EDGE";
else if (baBest <= 0) verdict = "NO_EXECUTABLE_EDGE";
else verdict = "NO_EXECUTABLE_EDGE";

L.push("-".repeat(120));
L.push("PLAIN-ENGLISH ANSWERS");
L.push("-".repeat(120));
L.push(
  `1. IMMEDIATE BID/ASK profitable? Best stop Exp=${f2(
    Math.max(...STOPS.map((s) => stats(C(key("IMMEDIATE", s, "BA"))).exp)),
  )} — ${
    Math.max(...STOPS.map((s) => stats(C(key("IMMEDIATE", s, "BA"))).exp)) > 0 ? "some stops >0" : "NO (all ≤0 or weak)"
  }.`,
);
L.push(
  `2. RECLAIM_M5 BID/ASK profitable? Best Exp=${f2(
    Math.max(...STOPS.map((s) => stats(C(key("RECLAIM_M5", s, "BA"))).exp)),
  )}.`,
);
L.push(
  `3. Higher expectancy: ${best.entry} stop=${best.stop} Exp=${f2(best.exp)} PF=${f2(best.pf)}.`,
);
L.push(
  `4. Reclaim hit-rate vs lost target: matched @10p ΔExp(reclaim−imm)=${f2(matchDelta)} (reclaim Exp=${f2(rec10.exp)} vs matched imm=${f2(imm10m.exp)}; rew med reclaim=${f1(rec10.medRew)} imm=${f1(imm10.medRew)}).`,
);
L.push(`5. Least-bad / best stop: ${best.entry} @ ${best.stop}p (Exp=${f2(best.exp)} PF=${f2(best.pf)}).`);
L.push(
  `6. Any Exp>0 AND PF>1? ${positive.length ? positive.map((c) => `${c.entry}@${c.stop}`).join(", ") : "NONE"}.`,
);
L.push(`7. Positive later-era survive? ${anyPosSurvive ? "YES" : "NO"}.`);
{
  const dragImm = stats(C(key("IMMEDIATE", 10, "MID"))).exp - imm10.exp;
  const dragRec = stats(C(key("RECLAIM_M5", 10, "MID"))).exp - rec10.exp;
  L.push(`8. Spread/execution drag @10p stop: IMM≈${f2(dragImm)}p/trade RECLAIM≈${f2(dragRec)}p/trade.`);
}
L.push(
  `9. Main problem: ${
    midBest > 0.5 && baBest <= 0
      ? "spread / execution vs small target"
      : baBest <= 0 && midBest <= 0
        ? "combination — stops/MAE + insufficient reward (even MID weak)"
        : "combination of spread, stop vs MAE, and small reward"
  }.`,
);
L.push(
  `10. Matched reclaim improves executable Exp? ${matchDelta > 0.1 ? "YES" : matchDelta > -0.1 ? "ROUGHLY FLAT" : "NO — waiting worse"}.`,
);
{
  const il = stats(C(key("IMMEDIATE", 10, "BA|LONG")));
  const is_ = stats(C(key("IMMEDIATE", 10, "BA|SHORT")));
  L.push(
    `11. LONG/SHORT: IMM L Exp=${f2(il.exp)} S Exp=${f2(is_.exp)} — ${
      Math.abs(il.exp - is_.exp) < 1 ? "reasonably symmetric" : "somewhat asymmetric"
    }.`,
  );
}
L.push(
  `12. Continue optimizing? ${
    verdict === "EXECUTABLE_EDGE_FOUND" || verdict === "MARGINAL_EXECUTABLE_EDGE"
      ? "Cautiously — freeze config, validate more, do not expand search wildly."
      : verdict === "BEHAVIOR_REAL_BUT_EXECUTION_KILLS_EDGE"
        ? "Only if addressing spread/target size; do not optimize stops alone."
        : "No — not enough executable evidence."
  }`,
);
L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-4h-aligned-midpoint-execution-v5-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
