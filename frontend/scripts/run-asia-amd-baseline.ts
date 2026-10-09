// Raw baseline for the causal Asia-range AMD state machine (src/lib/strategy/amd.ts):
// SWEEP → RECLAIM → DISPLACEMENT → OUTCOME on OANDA M15 mid candles, default
// parameters, nothing tuned. Also replays the machine candle by candle on real
// data to prove the live view is never rewritten, and measures how often the
// previous implementation (git HEAD) repainted.
//
//   AMD_DATA_DIR=<dir with {PAIR}_M15{,_2023,_2024,_2025}.json and calendar_high*.json>
//   AMD_LEGACY=<path to the old amd.ts, optional; inside src/ so its "@/" imports resolve:
//     git show 7667ad5:frontend/src/lib/strategy/amd.ts > src/lib/strategy/_amd-legacy-tmp.ts>
//   npx tsx scripts/run-asia-amd-baseline.ts
//
// Data files are the bid/ask caches written by
// api-server/research-v2/pullback-1to2-2026/fetch.mjs.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { AMD_DEFAULTS, AsiaAmdMachine, computeAmdDays, type AmdDay, type AmdNewsEvent } from "../src/lib/strategy/amd";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import type { Candle } from "../src/types/forex";

const DATA_DIR = process.env.AMD_DATA_DIR!;
const OUT_DIR = path.resolve(__dirname, "../../api-server/research-v2/asia-amd-state-machine-v1");
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD", "USD_CHF", "NZD_USD", "EUR_JPY", "GBP_JPY", "AUD_JPY"];
const FROM = Date.parse("2023-01-01T00:00:00Z");
const SUFFIXES = ["_2023", "_2024", "_2025", ""];

interface Series { candles: Candle[]; spreadByMs: Map<number, number> }

function loadSeries(pair: string): Series {
  const byMs = new Map<number, number[]>();
  for (const suffix of SUFFIXES) {
    const file = path.join(DATA_DIR, `${pair}_M15${suffix}.json`);
    for (const row of JSON.parse(fs.readFileSync(file, "utf8")) as number[][]) byMs.set(row[0]!, row);
  }
  const rows = [...byMs.values()].sort((a, b) => a[0]! - b[0]!);
  const pip = pipSizeFor(pair);
  const spreadByMs = new Map<number, number>();
  const candles = rows.map(([t, bo, bh, bl, bc, ao, ah, al, ac]) => {
    spreadByMs.set(t!, (ac! - bc!) / pip);
    return { time: new Date(t!).toISOString(), open: (bo! + ao!) / 2, high: (bh! + ah!) / 2, low: (bl! + al!) / 2, close: (bc! + ac!) / 2, volume: 0, complete: true };
  });
  return { candles, spreadByMs };
}

const news: AmdNewsEvent[] = SUFFIXES.flatMap((suffix) =>
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, `calendar_high${suffix}.json`), "utf8")) as AmdNewsEvent[]);

// ---- 1. Replay proof on real candles -----------------------------------------

/** Same invariant as scripts/test-asia-amd.ts: nothing known at a cut is rewritten later. */
function stableViolations(earlier: AmdDay[], later: AmdDay[]): string[] {
  const out: string[] = [];
  for (const before of earlier) {
    const after = later.find((day) => day.day === before.day);
    if (!after) { out.push(`${before.day} missing`); continue; }
    if (JSON.stringify(after.transitions.slice(0, before.transitions.length)) !== JSON.stringify(before.transitions)) out.push(`${before.day} transitions`);
    if (before.locked && (after.asiaHigh !== before.asiaHigh || after.asiaLow !== before.asiaLow)) out.push(`${before.day} asia levels`);
    if (before.distribution && (after.distribution?.direction !== before.distribution.direction || after.distribution?.entry !== before.distribution.entry)) out.push(`${before.day} distribution`);
    before.sweeps.forEach((sweep, i) => {
      if (after.sweeps[i]?.startTime !== sweep.startTime || after.sweeps[i]?.side !== sweep.side) out.push(`${before.day} sweep ${i}`);
    });
  }
  return out;
}

function replayProof(series: Series, pair: string) {
  const from = Date.parse("2026-06-01T00:00:00Z");
  const to = Date.parse("2026-09-01T00:00:00Z");
  const candles = series.candles.filter((c) => Date.parse(c.time) >= from - 30 * 86_400_000 && Date.parse(c.time) < to);
  const full = computeAmdDays(candles, pair);
  const machine = new AsiaAmdMachine(pair);
  let cuts = 0;
  let freshRuns = 0;
  const violations: string[] = [];
  candles.forEach((candle, n) => {
    machine.push(candle);
    const live = machine.snapshot();
    if (n % 96 === 0) {
      assert.deepEqual(computeAmdDays(candles.slice(0, n + 1), pair), live, `${pair} fresh replay at ${candle.time} differs`);
      freshRuns += 1;
    }
    violations.push(...stableViolations(live, full));
    cuts += 1;
  });
  return { cuts, freshRuns, violations: violations.length, days: full.length };
}

interface LegacyDay {
  day: string;
  asiaHigh: number;
  asiaLow: number;
  phase: string;
  manipulation: { direction: string; sweepTime: string } | null;
  distribution: { direction: string; startTime: string } | null;
}

/**
 * How often the previous implementation (git HEAD amd.ts) showed a resolved
 * label during the day — "breakout", "distribution" (= manipulation found) or
 * "no-sweep" — that it changed once more candles arrived. Normal progression
 * (accumulation → manipulation in play → resolved) is not counted.
 */
async function legacyRepaint(series: Series, pair: string) {
  const legacyPath = process.env.AMD_LEGACY;
  if (!legacyPath) return null;
  const legacy = await import(pathToFileURL(path.resolve(legacyPath)).href) as { computeAmdDays: (c: Candle[], i: string) => LegacyDay[] };
  const from = Date.parse("2026-01-05T00:00:00Z");
  const candles = series.candles.filter((c) => Date.parse(c.time) >= from - 10 * 86_400_000);
  const direction = (d: LegacyDay) => d.manipulation?.direction ?? d.distribution?.direction ?? "-";
  const resolved = (d: LegacyDay) => ["breakout", "distribution", "no-sweep"].includes(d.phase);
  let days = 0;
  let repainted = 0;
  let flippedDirection = 0;
  let breakoutToManip = 0;
  let mFromOpen = 0;
  for (const final of legacy.computeAmdDays(candles, pair)) {
    const dayMs = Date.parse(`${final.day}T00:00:00Z`);
    if (dayMs < from || !resolved(final)) continue;
    days += 1;
    let changed = false;
    let flip = false;
    let promoted = false;
    // Cut after every London/NY candle of the day, with three days of lookback.
    const window = candles.filter((c) => { const t = Date.parse(c.time); return t >= dayMs - 3 * 86_400_000 && t < dayMs + 21 * 3_600_000; });
    for (let n = 0; n < window.length; n += 1) {
      if (Date.parse(window[n]!.time) < dayMs + 7 * 3_600_000) continue;
      const shown = legacy.computeAmdDays(window.slice(0, n + 1), pair).find((d) => d.day === final.day);
      if (!shown || !resolved(shown)) continue;
      if (shown.phase !== final.phase || direction(shown) !== direction(final)) changed = true;
      if (direction(shown) !== "-" && direction(final) !== "-" && direction(shown) !== direction(final)) flip = true;
      if (shown.phase === "breakout" && final.phase === "distribution") promoted = true;
    }
    if (changed) repainted += 1;
    if (flip) flippedDirection += 1;
    if (promoted) breakoutToManip += 1;
    // The M box always started at 07:00, even when 07:00 traded inside the range.
    const open = window.find((c) => Date.parse(c.time) === dayMs + 7 * 3_600_000);
    if (final.manipulation && open && open.high <= final.asiaHigh && open.low >= final.asiaLow) mFromOpen += 1;
  }
  return { days, repainted, flippedDirection, breakoutToManip, movedBack: mFromOpen };
}

// ---- 2. Baseline ------------------------------------------------------------------

interface Row {
  pair: string;
  day: AmdDay;
  spreadPips: number | null;
  year: string;
  /** Descriptive, from the candles after the fact (never fed back): both Asian sides traded 07–13 UTC. */
  londonBoth: boolean;
  /** Accepted breakout that later (by 21:00) traded through the other Asian side. */
  acceptedLateReversal: boolean;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–");
const ci = (n: number, d: number) => {
  if (!d) return "–";
  const p = n / d;
  return `${(100 * p).toFixed(1)}% ±${(196 * Math.sqrt((p * (1 - p)) / d)).toFixed(1)}`;
};
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");

type OutcomeKey = "outcome" | "reclaimOutcome" | "continuationOutcome";

function raceLine(rows: Row[], key: OutcomeKey, x: number) {
  let win = 0; let loss = 0; let both = 0; let open = 0;
  for (const { day } of rows) {
    const r = day[key]?.race[x];
    if (r === "win") win += 1; else if (r === "loss") loss += 1; else if (r === "both") both += 1; else if (r === "open") open += 1;
  }
  return { win, loss, both, open, decided: win + loss + both };
}

function raceTable(rows: Row[], key: OutcomeKey) {
  const lines = ["| target | n decided | first +X | first −X | same candle | neither by 21:00 |", "|---|---|---|---|---|---|"];
  for (const x of AMD_DEFAULTS.outcomePips) {
    const r = raceLine(rows, key, x);
    lines.push(`| ±${x}p | ${r.decided} | ${ci(r.win, r.decided)} | ${pct(r.loss, r.decided)} | ${pct(r.both, r.decided)} | ${r.open} |`);
  }
  return lines.join("\n");
}

function structural(rows: Row[]) {
  const trades = rows.filter((r) => r.day.distribution && r.day.distribution.structural.result !== "n/a");
  const gross = trades.map((r) => r.day.distribution!.structural.r!);
  const net = trades.map((r) => r.day.distribution!.structural.r! - (r.spreadPips ?? 0) / r.day.distribution!.riskPips);
  const wins = trades.filter((r) => r.day.distribution!.structural.result === "win").length;
  return { n: trades.length, wins, gross: mean(gross), net: mean(net), sumNet: net.reduce((a, b) => a + b, 0) };
}

function bucketTable(title: string, rows: Row[], bucket: (row: Row) => string | null, order?: string[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const b = bucket(row);
    if (b === null) continue;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(row);
  }
  const keys = order ?? [...groups.keys()].sort();
  const lines = [`**${title}**`, "", "| bucket | AMD n | +10 before −10 | +20 before −20 | opposite boundary | structural n | win | avg R gross | avg R net |", "|---|---|---|---|---|---|---|---|---|"];
  for (const k of keys) {
    const g = groups.get(k) ?? [];
    const r10 = raceLine(g, "outcome", 10);
    const r20 = raceLine(g, "outcome", 20);
    const opp = g.filter((r) => r.day.distribution!.oppositeReached !== "no").length;
    const s = structural(g);
    lines.push(`| ${k} | ${g.length} | ${ci(r10.win, r10.decided)} | ${ci(r20.win, r20.decided)} | ${pct(opp, g.length)} | ${s.n} | ${pct(s.wins, s.n)} | ${f(s.gross)} | ${f(s.net)} |`);
  }
  return lines.join("\n");
}

function terciles(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return [s[Math.floor(s.length / 3)]!, s[Math.floor((2 * s.length) / 3)]!];
}

/** First reclaimed-or-accepted sweep of the day: the London decision the funnel follows. */
function firstSweep(day: AmdDay) {
  return day.sweeps[0] ?? null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows: Row[] = [];
  const closeRows: Row[] = [];
  const proofs: Record<string, ReturnType<typeof replayProof>> = {};
  const legacy: Record<string, Awaited<ReturnType<typeof legacyRepaint>>> = {};
  let example: string | null = null;

  for (const pair of PAIRS) {
    const series = loadSeries(pair);
    const sessionBars = new Map<string, Array<{ ms: number; high: number; low: number }>>();
    for (const candle of series.candles) {
      const ms = Date.parse(candle.time);
      const hour = new Date(ms).getUTCHours();
      if (hour < 7 || hour >= 21) continue;
      const key = candle.time.slice(0, 10);
      if (!sessionBars.has(key)) sessionBars.set(key, []);
      sessionBars.get(key)!.push({ ms, high: candle.high, low: candle.low });
    }
    const toRows = (days: AmdDay[]): Row[] => days
      .filter((day) => Date.parse(`${day.day}T00:00:00Z`) >= FROM)
      .map((day) => {
        const confirmMs = day.distribution ? Date.parse(day.distribution.barTime) : null;
        const bars = sessionBars.get(day.day) ?? [];
        const london = bars.filter((b) => b.ms < Date.parse(day.londonEnd));
        const accepted = day.accepted;
        return {
          pair, day, year: day.day.slice(0, 4),
          spreadPips: confirmMs === null ? null : series.spreadByMs.get(confirmMs) ?? null,
          londonBoth: london.some((b) => b.high > day.asiaHigh) && london.some((b) => b.low < day.asiaLow),
          acceptedLateReversal: !!accepted && bars.some((b) => b.ms >= Date.parse(accepted.time)
            && (accepted.direction === "short" ? b.high > day.asiaHigh : b.low < day.asiaLow)),
        };
      });
    const days = computeAmdDays(series.candles, pair, { news });
    rows.push(...toRows(days));
    closeRows.push(...toRows(computeAmdDays(series.candles, pair, { news, config: { reclaimMode: "CLOSE" } })));
    if (pair === "EUR_USD" || pair === "GBP_USD" || pair === "USD_JPY") proofs[pair] = replayProof(series, pair);
    if (pair === "EUR_USD" || pair === "GBP_USD") legacy[pair] = await legacyRepaint(series, pair);
    if (pair === "EUR_USD") example = candleByCandle(series, days);
    console.log(pair, days.length, "days");
  }

  // ---- funnel
  const valid = rows.filter((r) => r.day.state !== "INVALID");
  const invalid = rows.length - valid.length;
  const swept = valid.filter((r) => r.day.sweeps.length > 0);
  const noSweep = valid.filter((r) => r.day.state === "NO_SWEEP");
  const firsts = swept.map((r) => firstSweep(r.day)!);
  const firstReclaimed = firsts.filter((s) => s.reclaimTime !== null).length;
  const firstAccepted = firsts.filter((s) => s.status === "accepted").length;
  const anyReclaim = swept.filter((r) => r.day.sweeps.some((s) => s.reclaimTime));
  const amd = valid.filter((r) => r.day.state === "DISTRIBUTION_CONFIRMED");
  const accepted = valid.filter((r) => r.day.state === "BREAKOUT_ACCEPTED");
  const expired = valid.filter((r) => r.day.state === "EXPIRED");
  const doubles = valid.filter((r) => r.day.doubleSweep);
  const reclaimsTotal = swept.reduce((n, r) => n + r.day.sweeps.filter((s) => s.reclaimTime).length, 0);
  const reclaimsDisplaced = swept.reduce((n, r) => n + r.day.sweeps.filter((s) => s.status === "distribution").length, 0);
  const reclaimsNoDisp = swept.reduce((n, r) => n + r.day.sweeps.filter((s) => s.status === "no-displacement").length, 0);
  const reclaimsRebroken = swept.reduce((n, r) => n + r.day.sweeps.filter((s) => s.status === "re-broken").length, 0);
  const reclaimsSuperseded = swept.reduce((n, r) => n + r.day.sweeps.filter((s) => s.status === "superseded" && s.reclaimTime).length, 0);
  const acceptReasons = { closes: 0, distance: 0, timeout: 0 };
  for (const r of accepted) acceptReasons[r.day.accepted!.reason] += 1;

  const opp = amd.filter((r) => r.day.distribution!.oppositeReached !== "no");
  const oppAlready = amd.filter((r) => r.day.distribution!.oppositeReached === "already").length;
  const mid = amd.filter((r) => r.day.distribution!.midpointReached !== "no").length;
  const times = amd.map((r) => r.day.distribution!.minutesToOpposite).filter((m): m is number => m !== null && m > 0);
  const st = structural(amd);
  const stClose = structural(closeRows.filter((r) => r.day.state === "DISTRIBUTION_CONFIRMED"));
  const spreads = amd.map((r) => r.spreadPips).filter((s): s is number => s !== null);
  const rrs = amd.map((r) => r.day.distribution!.rr).filter((x): x is number => x !== null);

  // ---- buckets
  const depthBucket = (r: Row) => {
    const sw = r.day.sweeps.find((s) => s.status === "distribution");
    if (!sw) return null;
    const d = sw.depthPips;
    return d < 2 ? "a 0–2p" : d < 5 ? "b 2–5p" : d < 10 ? "c 5–10p" : "d 10p+";
  };
  const [ra1, ra2] = terciles(amd.map((r) => r.day.asiaRangeAtr).filter((x): x is number => x !== null));
  const [q1, q2] = terciles(amd.map((r) => r.day.quality?.score).filter((x): x is number => x !== undefined));
  const rangeBucket = (r: Row) => r.day.asiaRangeAtr === null ? null : r.day.asiaRangeAtr < ra1 ? `a < ${f(ra1)} ATR` : r.day.asiaRangeAtr < ra2 ? `b ${f(ra1)}–${f(ra2)} ATR` : `c ≥ ${f(ra2)} ATR`;
  const qualityBucket = (r: Row) => !r.day.quality ? null : r.day.quality.score < q1 ? `a low (< ${f(q1)})` : r.day.quality.score < q2 ? "b mid" : `c high (≥ ${f(q2)})`;
  const hourBucket = (r: Row) => {
    const sw = r.day.sweeps.find((s) => s.status === "distribution");
    return sw ? `${String(new Date(sw.startTime).getUTCHours()).padStart(2, "0")}:00 UTC` : null;
  };

  const perPair = PAIRS.map((pair) => {
    const p = amd.filter((r) => r.pair === pair);
    const r10 = raceLine(p, "outcome", 10);
    const s = structural(p);
    const v = valid.filter((r) => r.pair === pair);
    return `| ${pair} | ${v.length} | ${pct(v.filter((r) => r.day.sweeps.length).length, v.length)} | ${p.length} | ${ci(r10.win, r10.decided)} | ${s.n} | ${f(s.gross)} | ${f(s.net)} |`;
  });
  const perYear = ["2023", "2024", "2025", "2026"].map((year) => {
    const p = amd.filter((r) => r.year === year);
    const r10 = raceLine(p, "outcome", 10);
    const s = structural(p);
    return `| ${year} | ${p.length} | ${ci(r10.win, r10.decided)} | ${s.n} | ${f(s.gross)} | ${f(s.net)} |`;
  });
  const perDirection = (["long", "short"] as const).map((dir) => {
    const p = amd.filter((r) => r.day.distribution!.direction === dir);
    const r10 = raceLine(p, "outcome", 10);
    const s = structural(p);
    return `| ${dir} | ${p.length} | ${ci(r10.win, r10.decided)} | ${f(s.gross)} | ${f(s.net)} |`;
  });

  const proofLines = Object.entries(proofs).map(([pair, p]) =>
    `| ${pair} | Jun–Aug 2026 | ${p.days} | ${p.cuts} | ${p.freshRuns} | ${p.violations} |`);
  const legacyLines = Object.entries(legacy).filter(([, v]) => v).map(([pair, v]) =>
    `| ${pair} | ${v!.days} | ${pct(v!.repainted, v!.days)} (${v!.repainted}) | ${v!.breakoutToManip} | ${v!.flippedDirection} | ${v!.movedBack} |`);

  const report = `# Asia-range AMD state machine — raw baseline (v1)

Generated ${new Date().toISOString().slice(0, 10)} by \`frontend/scripts/run-asia-amd-baseline.ts\` from the
module the chart draws (\`frontend/src/lib/strategy/amd.ts\`). Default parameters, **nothing tuned**.
OANDA M15 mid candles, ${PAIRS.length} pairs, 2023-01-01 → 2026-10-06. High-impact TradingView calendar for the news flag.

Defaults: Asia 00:00–07:00 UTC · sweeps may start 07:00–13:00 · resolution/outcomes until 21:00 ·
any trade through the level is a sweep (minSweepPips 0) · reclaim = close back inside ·
acceptance = 2 closes outside, or one close ≥ 2 M15-ATR outside, or 4 candles without reclaim ·
reclaimMode CLOSE_PLUS_DISPLACEMENT · displacement = body ≥ 1.0 × average body of the previous 20 candles,
closing beyond the previous close in the expected direction, within 4 candles of the reclaim ·
entry = close of the confirming candle.

## 1. Replay proof (no lookahead)

The machine was fed real candles one at a time. After **every** candle, everything it knew
(transitions, frozen Asia levels, sweep starts/sides, distribution entry/direction) was checked against
the full-history run; every 96 candles a fresh run on the truncated series was checked for exact equality.

| pair | window | days | cuts checked | fresh replays | violations |
|---|---|---|---|---|---|
${proofLines.join("\n")}

Previous implementation (git HEAD \`amd.ts\`), same check — cut after every London/NY candle of each
2026 day and compared with what it showed once the day was over:

| pair | resolved days | resolved label later changed | "breakout" later relabelled manipulation | direction flipped | M box starts 07:00 though 07:00 was inside the range |
|---|---|---|---|---|---|
${legacyLines.join("\n")}

## 2. Funnel: SWEEP → RECLAIM → DISPLACEMENT → OUTCOME

| step | count | rate |
|---|---|---|
| Asia sessions (valid) | ${valid.length} | (${invalid} invalid: holidays / thin data) |
| London swept at least one side | ${swept.length} | ${pct(swept.length, valid.length)} of sessions |
| no sweep | ${noSweep.length} | ${pct(noSweep.length, valid.length)} |
| first sweep reclaimed (close back inside) | ${firstReclaimed} | ${pct(firstReclaimed, swept.length)} of swept days |
| first sweep accepted (continuation) | ${firstAccepted} | ${pct(firstAccepted, swept.length)} of swept days |
| days with any reclaim | ${anyReclaim.length} | ${pct(anyReclaim.length, swept.length)} of swept days |
| reclaims (all attempts) | ${reclaimsTotal} | – |
| → displacement in time (D) | ${reclaimsDisplaced} | ${pct(reclaimsDisplaced, reclaimsTotal)} of reclaims |
| → no displacement in 4 candles | ${reclaimsNoDisp} | ${pct(reclaimsNoDisp, reclaimsTotal)} |
| → closed back outside first | ${reclaimsRebroken} | ${pct(reclaimsRebroken, reclaimsTotal)} |
| → other side swept first | ${reclaimsSuperseded} | ${pct(reclaimsSuperseded, reclaimsTotal)} |
| **DISTRIBUTION_CONFIRMED days** | **${amd.length}** | ${pct(amd.length, valid.length)} of sessions |
| BREAKOUT_ACCEPTED days | ${accepted.length} | ${pct(accepted.length, valid.length)} (closes ${acceptReasons.closes}, distance ${acceptReasons.distance}, timeout ${acceptReasons.timeout}) |
| EXPIRED days (reclaimed, never displaced) | ${expired.length} | ${pct(expired.length, valid.length)} |
| double-sweep days (both sides swept while the machine was still deciding) | ${doubles.length} | ${pct(doubles.length, valid.length)} |

Context, measured after the fact and never fed to the machine: London (07–13) traded through **both**
Asian sides on ${pct(valid.filter((r) => r.londonBoth).length, valid.length)} of sessions — most of those after the day had
already resolved, which is why the in-sequence double sweep is rare. Of the ${accepted.length} accepted
breakouts, **${pct(accepted.filter((r) => r.acceptedLateReversal).length, accepted.length)} later traded through the other Asian side by 21:00** —
the days the previous implementation relabelled as "manipulation" after the fact.

## 3. Outcome after confirmed AMD (from the confirming close, until 21:00 UTC)

Which comes first, +X or −X pips. **A coin flip is 50%.** "Same candle" counts against the setup.

${raceTable(amd, "outcome")}

Median MFE ${f(median(amd.map((r) => r.day.outcome!.mfePips)), 1)}p, median MAE ${f(median(amd.map((r) => r.day.outcome!.maePips)), 1)}p.
Median spread at entry ${f(median(spreads), 1)}p.

Asia levels as targets: midpoint reached (or already passed at entry) ${pct(mid, amd.length)};
**opposite Asia boundary reached ${pct(opp.length, amd.length)}** (${oppAlready} already beyond it at entry);
median time to it ${f(median(times), 0)} min. Median structural R:R (reward to the far boundary / risk to the sweep extreme) ${f(median(rrs))}.

Structural trade (stop at the sweep extreme, target the opposite Asia boundary, closed at 21:00):
n ${st.n}, win ${pct(st.wins, st.n)}, avg **${f(st.gross)}R gross / ${f(st.net)}R net of spread** (sum ${f(st.sumNet, 1)}R).
Same trade in CLOSE mode (reclaim alone confirms): n ${stClose.n}, win ${pct(stClose.wins, stClose.n)}, ${f(stClose.gross)}R gross / ${f(stClose.net)}R net.

### Comparisons on the same days

Every first reclaim, displacement or not (from the reclaim close, in the AMD direction):

${raceTable(valid, "reclaimOutcome")}

Accepted breakouts, traded as continuation (from the acceptance close, in the breakout direction):

${raceTable(accepted, "continuationOutcome")}

## 4. Breakdowns (confirmed AMD days)

| pair | sessions | swept | AMD | +10 before −10 | structural n | avg R gross | avg R net |
|---|---|---|---|---|---|---|---|
${perPair.join("\n")}

| year | AMD | +10 before −10 | structural n | avg R gross | avg R net |
|---|---|---|---|---|---|
${perYear.join("\n")}

| direction | AMD | +10 before −10 | avg R gross | avg R net |
|---|---|---|---|---|
${perDirection.join("\n")}

${bucketTable("Q7 — sweep depth (the sweep that completed)", amd, depthBucket)}

${bucketTable("Q8 — Asia range size (range / daily ATR, terciles)", amd, rangeBucket)}

${bucketTable("Asia quality score (terciles; recorded, not filtered)", amd, qualityBucket)}

${bucketTable("Q9 — London hour of the sweep", amd, hourBucket)}

${bucketTable("Q10 — double sweep", amd, (r) => (r.day.doubleSweep ? "double" : "single"), ["single", "double"])}

${bucketTable("News within 30 min of the London action", amd, (r) => (r.day.newsNearby === null ? null : r.day.newsNearby ? "news" : "no news"), ["no news", "news"])}

${bucketTable("Abnormal candle (> 3 ATR) during the sequence", amd, (r) => (r.day.abnormalVolatility ? "abnormal" : "normal"), ["normal", "abnormal"])}

## 5. One day, candle by candle (EUR/USD)

${example ?? ""}
`;
  fs.writeFileSync(path.join(OUT_DIR, "REPORT.md"), report);

  const csvHead = "pair,date,state,asiaHigh,asiaLow,asiaRangePips,asiaRangeAtr,asiaQuality,sweepOccurred,firstSweepSide,firstSweepTime,firstSweepDepthPips,barsOutsideRange,reclaimOccurred,barsToReclaim,reclaimTime,displacementConfirmed,distributionDirection,entryTime,entry,stop,target,rr,spreadPips,doubleSweep,secondSweepSide,secondSweepTime,secondSweepDepthPips,breakoutAccepted,acceptReason,newsNearby,abnormalVolatility,mfePips,maePips,race5,race10,race15,race20,midpointReached,oppositeReached,minutesToOpposite,structuralResult,structuralR";
  const csv = [csvHead, ...rows.map(({ pair, day, spreadPips }) => {
    const s1 = day.sweeps[0];
    const s2 = s1 ? day.sweeps.find((s) => s.side !== s1.side) : undefined;
    const done = day.sweeps.find((s) => s.status === "distribution");
    const d = day.distribution;
    const o = day.outcome;
    return [
      pair, day.day, day.state, day.asiaHigh, day.asiaLow, f(day.asiaRangePips, 1), day.asiaRangeAtr === null ? "" : f(day.asiaRangeAtr, 3), day.quality ? f(day.quality.score, 3) : "",
      day.sweeps.length > 0, s1?.side ?? "", s1?.startTime ?? "", s1 ? f(s1.depthPips, 1) : "", s1?.outsideCloses ?? "",
      day.sweeps.some((s) => s.reclaimTime), (done ?? s1)?.barsToReclaim ?? "", (done ?? s1)?.reclaimTime ?? "",
      !!d, d?.direction ?? "", d?.time ?? "", d?.entry ?? "", d?.stop ?? "", d?.target ?? "", d?.rr === null || !d ? "" : f(d.rr, 2), spreadPips === null ? "" : f(spreadPips, 2),
      day.doubleSweep, s2?.side ?? "", s2?.startTime ?? "", s2 ? f(s2.depthPips, 1) : "",
      day.state === "BREAKOUT_ACCEPTED", day.accepted?.reason ?? "", day.newsNearby ?? "", day.abnormalVolatility,
      o ? f(o.mfePips, 1) : "", o ? f(o.maePips, 1) : "", o?.race[5] ?? "", o?.race[10] ?? "", o?.race[15] ?? "", o?.race[20] ?? "",
      d?.midpointReached ?? "", d?.oppositeReached ?? "", d?.minutesToOpposite ?? "", d?.structural.result ?? "", d?.structural.r === null || !d ? "" : f(d.structural.r, 3),
    ].join(",");
  })].join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "days.csv"), csv);
  console.log(report);
}

/** A recent EUR/USD day that completed the sequence, replayed one candle at a time. */
function candleByCandle(series: Series, days: AmdDay[]): string {
  const pick = [...days].reverse().find((d) => d.state === "DISTRIBUTION_CONFIRMED" && d.sweeps.length === 1 && (d.sweeps[0]!.barsToReclaim ?? 0) >= 1 && d.transitions.some((t) => t.to === "WAITING_FOR_DISPLACEMENT"));
  if (!pick) return "";
  const dayMs = Date.parse(`${pick.day}T00:00:00Z`);
  const machine = new AsiaAmdMachine("EUR_USD");
  const lines = [
    `**${pick.day}** — Asia ${pick.asiaLow.toFixed(5)}–${pick.asiaHigh.toFixed(5)} (${f(pick.asiaRangePips, 1)}p). State after each closed candle, fed one at a time:`,
    "",
    "| candle (UTC) | open | high | low | close | state after close | what changed |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const candle of series.candles) {
    const t = Date.parse(candle.time);
    if (t >= dayMs + 21 * 3_600_000) break;
    machine.push(candle);
    if (t < dayMs + 6 * 3_600_000 + 30 * 60_000) continue;
    const day = machine.snapshot().find((d) => d.day === pick.day)!;
    const notes = day.transitions.filter((x) => Date.parse(x.time) === t + 15 * 60_000).map((x) => x.to === x.from ? x.note : `→ ${x.to}: ${x.note}`);
    const terminalSince = day.transitions.find((x) => x.to === day.state);
    if (day.state === "DISTRIBUTION_CONFIRMED" && terminalSince && Date.parse(terminalSince.time) < t - 45 * 60_000) break;
    lines.push(`| ${candle.time.slice(11, 16)} | ${candle.open.toFixed(5)} | ${candle.high.toFixed(5)} | ${candle.low.toFixed(5)} | ${candle.close.toFixed(5)} | ${day.state} | ${notes.join("; ")} |`);
  }
  const d = pick.distribution!;
  lines.push("", `Final for the day: ${d.direction} from ${d.entry.toFixed(5)}, stop ${d.stop.toFixed(5)}, opposite boundary ${d.target.toFixed(5)} ${d.oppositeReached}; +10 race: ${pick.outcome!.race[10]}; structural: ${d.structural.result} (${f(d.structural.r ?? NaN)}R).`);
  return lines.join("\n");
}

void main();
