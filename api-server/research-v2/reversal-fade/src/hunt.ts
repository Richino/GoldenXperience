import { DEV_GATE, H1_HORIZONS, H4_HORIZONS, IMPULSE_ATRS, M15_PRIOR, PAIRS, SLIPPAGE_PIPS, STRATEGY_VERSION, STRUCTURE_EXT_ATRS, ZONES } from "./config.js";
import { labelSignal } from "./labels.js";
import { labelRExit, labelRetraceExit } from "./exits.js";
import { loadPanel, spreadOverAtr, zoneOf, type Panel } from "./panels.js";
import { detectAll, detectBreak20 } from "./setups.js";
import { appendExperiment, freezeCandidate, writeReport } from "./registry.js";
import { runLeakageSelfTest } from "./selftest.js";
import {
  bucketExt,
  concentration,
  EXT_BUCKETS,
  fmt,
  groupBy,
  metricsPurgedOnly,
} from "./stats.js";
import type { ExperimentRow, MetricRow, SetupKind, Signal, Trade, Zone } from "./types.js";
import { mean, percentile } from "../../src/math.js";

type CellKey = string;

function cellKey(tf: string, kind: string, param: string, side: string, delay: number, horizon: number): CellKey {
  return `${tf}|${kind}|${param}|${side}|d${delay}|h${horizon}`;
}

function horizonsFor(tf: string): readonly number[] {
  return tf === "H4" ? H4_HORIZONS : H1_HORIZONS;
}

function tradesFor(
  panels: Map<string, Panel>,
  signals: Signal[],
  zone: Zone,
  side: Trade["side"],
  delay: number,
  horizon: number,
  allowSealed: boolean,
): Trade[] {
  const out: Trade[] = [];
  for (const s of signals) {
    if (zoneOf(s.closeTime) !== zone) continue;
    const panel = panels.get(`${s.instrument}|${s.timeframe}`);
    if (!panel) continue;
    const t = labelSignal({ panel, signal: s, side, delay, horizon, allowSealed });
    if (t) out.push(t);
  }
  return out;
}

function pairNet(trades: Trade[]): Record<string, { n: number; net: number }> {
  const g = groupBy(trades, (t) => t.instrument);
  const out: Record<string, { n: number; net: number }> = {};
  for (const [k, arr] of g) out[k] = { n: arr.length, net: mean(arr.map((t) => t.netAtr)) };
  return out;
}

function rowOf(args: {
  zone: Zone;
  instrument: "ALL";
  timeframe: string;
  kind: SetupKind;
  param: string;
  side: Trade["side"];
  delay: number;
  horizon: number;
  trades: Trade[];
  status: ExperimentRow["status"];
  reason: string;
  sealedTouched: boolean;
}): ExperimentRow {
  const m = metricsPurgedOnly(args.trades);
  const longs = args.trades.filter((t) => t.direction === "long");
  const shorts = args.trades.filter((t) => t.direction === "short");
  return {
    experimentId: `rf-${args.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    zone: args.zone,
    instrument: args.instrument,
    timeframe: args.timeframe,
    kind: args.kind,
    param: args.param,
    side: args.side,
    delay: args.delay,
    horizon: args.horizon,
    metrics: m,
    byPair: pairNet(args.trades),
    longNet: mean(longs.map((t) => t.netAtr)),
    shortNet: mean(shorts.map((t) => t.netAtr)),
    longN: longs.length,
    shortN: shorts.length,
    status: args.status,
    reason: args.reason,
    sealedTouched: args.sealedTouched,
  };
}

function headlineParam(kind: SetupKind, param: string, tf: string): boolean {
  if (kind === "break20") return true;
  if (kind === "impulse_1bar") return param === "th=0.75";
  if (kind === "impulse_multibar") return param.endsWith("th=0.75");
  if (kind === "structure") return /th=0\.5$/.test(param);
  if (kind === "momentum") return tf === "H4" ? param.includes("run>=3") : param.includes("run>=4") && param.includes("0.75");
  return false;
}

type Combo = { kind: SetupKind; param: string; minExt: number; baseParam: string };

function expandCombos(kind: SetupKind, baseParam: string): Combo[] {
  if (kind === "impulse_1bar" && baseParam === "raw") {
    return IMPULSE_ATRS.map((th) => ({ kind, param: `th=${th}`, minExt: th, baseParam }));
  }
  if (kind === "impulse_multibar") {
    return IMPULSE_ATRS.map((th) => ({ kind, param: `${baseParam},th=${th}`, minExt: th, baseParam }));
  }
  if (kind === "structure") {
    return STRUCTURE_EXT_ATRS.map((th) => ({ kind, param: `${baseParam},th=${th}`, minExt: th, baseParam }));
  }
  return [{ kind, param: baseParam, minExt: 0, baseParam }];
}

function fmtCost(s: { n: number; p25: number; p50: number; p75: number; p90: number }): string {
  return `n=${s.n}  p25=${s.p25.toFixed(4)}  p50=${s.p50.toFixed(4)}  p75=${s.p75.toFixed(4)}  p90=${s.p90.toFixed(4)}`;
}

type Robust = Record<string, { net: number; ciLow: number; ciHigh: number; n: number }>;

function mshort(trades: Trade[]): { net: number; ciLow: number; ciHigh: number; n: number } {
  const m = metricsPurgedOnly(trades);
  return { net: m.net, ciLow: m.ci95Low, ciHigh: m.ci95High, n: m.effectiveN };
}

function matchExpanded(s: Signal, kind: SetupKind, param: string, timeframe: string): boolean {
  if (s.timeframe !== timeframe || s.kind !== kind) return false;
  if (kind === "impulse_1bar") {
    const th = Number(param.replace("th=", ""));
    return s.param === "raw" && s.extensionAtr >= th;
  }
  if (kind === "impulse_multibar") {
    const [lPart, thPart] = param.split(",");
    const th = Number((thPart ?? "").replace("th=", ""));
    return s.param === lPart && s.extensionAtr >= th;
  }
  if (kind === "structure") {
    const [kPart, thPart] = param.split(",");
    const th = Number((thPart ?? "").replace("th=", ""));
    return s.param === kPart && s.extensionAtr >= th;
  }
  return s.param === param;
}

function robustness(devTrades: Trade[], panels: Map<string, Panel>, signals: Signal[], spec: {
  timeframe: string;
  kind: SetupKind;
  param: string;
  delay: number;
  horizon: number;
}): { ok: boolean; details: Robust } {
  const base = mshort(devTrades);
  const cost = (mult: number) =>
    mshort(
      devTrades.map((t) => ({ ...t, netAtr: t.netAtr - mult * t.spreadCostAtr })),
    );
  const extraSlip = mshort(devTrades.map((t) => ({ ...t, netAtr: t.netAtr - t.slippageCostAtr })));

  const subset = signals.filter((s) => matchExpanded(s, spec.kind, spec.param, spec.timeframe));
  const delay1 = mshort(tradesFor(panels, subset, "dev", "fade", 1, spec.horizon, false));
  const delay2 = mshort(tradesFor(panels, subset, "dev", "fade", 2, spec.horizon, false));

  const byPair = groupBy(devTrades, (t) => t.instrument);
  let bestPair = "";
  let bestV = -Infinity;
  for (const [k, arr] of byPair) {
    const v = arr.reduce((s, t) => s + t.netAtr, 0);
    if (v > bestV) {
      bestV = v;
      bestPair = k;
    }
  }
  const dropPair = mshort(devTrades.filter((t) => t.instrument !== bestPair));

  const byMonth = groupBy(devTrades, (t) => t.entryTime.slice(0, 7));
  let bestM = "";
  bestV = -Infinity;
  for (const [k, arr] of byMonth) {
    const v = arr.reduce((s, t) => s + t.netAtr, 0);
    if (v > bestV) {
      bestV = v;
      bestM = k;
    }
  }
  const dropMonth = mshort(devTrades.filter((t) => t.entryTime.slice(0, 7) !== bestM));

  const byQ = groupBy(devTrades, (t) => {
    const mo = Number(t.entryTime.slice(5, 7));
    const q = Math.ceil(mo / 3);
    return `${t.entryTime.slice(0, 4)}Q${q}`;
  });
  let bestQ = "";
  bestV = -Infinity;
  for (const [k, arr] of byQ) {
    const v = arr.reduce((s, t) => s + t.netAtr, 0);
    if (v > bestV) {
      bestV = v;
      bestQ = k;
    }
  }
  const dropQ = mshort(devTrades.filter((t) => {
    const mo = Number(t.entryTime.slice(5, 7));
    const q = Math.ceil(mo / 3);
    return `${t.entryTime.slice(0, 4)}Q${q}` !== bestQ;
  }));

  const sorted = [...devTrades].sort((a, b) => b.netAtr - a.netAtr);
  const drop5set = new Set(sorted.slice(0, 5));
  const drop10set = new Set(sorted.slice(0, 10));
  const drop5 = mshort(devTrades.filter((t) => !drop5set.has(t)));
  const drop10 = mshort(devTrades.filter((t) => !drop10set.has(t)));

  const mid = Math.floor(devTrades.length / 2);
  const ordered = [...devTrades].sort((a, b) => a.entryTime.localeCompare(b.entryTime));
  const first = mshort(ordered.slice(0, mid));
  const second = mshort(ordered.slice(mid));
  const L = mshort(devTrades.filter((t) => t.direction === "long"));
  const S = mshort(devTrades.filter((t) => t.direction === "short"));

  const details: Robust = {
    base,
    cost25: cost(0.25),
    cost50: cost(0.5),
    extraSlip,
    delay1,
    delay2,
    dropBestPair: dropPair,
    dropBestMonth: dropMonth,
    dropBestQuarter: dropQ,
    dropTop5: drop5,
    dropTop10: drop10,
    firstHalf: first,
    secondHalf: second,
    longOnly: L,
    shortOnly: S,
  };

  const ok =
    cost(0.25).ciLow > 0 &&
    cost(0.5).net > 0 &&
    delay1.net > 0 &&
    dropPair.net > 0 &&
    dropMonth.net > 0 &&
    drop5.net > 0 &&
    first.net > 0 &&
    second.net > 0 &&
    (L.n < 15 || L.net > 0) &&
    (S.n < 15 || S.net > 0);

  return { ok, details };
}

function neighborhoodOk(
  cells: Map<CellKey, Trade[]>,
  tf: string,
  kind: SetupKind,
  param: string,
  horizon: number,
): boolean {
  if (kind !== "impulse_1bar" && kind !== "impulse_multibar" && kind !== "structure") return true;
  const neighbors: string[] = [];
  if (kind === "impulse_1bar") neighbors.push("th=0.5", "th=0.75", "th=1");
  if (kind === "impulse_multibar") {
    const L = param.split(",")[0] ?? "L=4";
    neighbors.push(`${L},th=0.5`, `${L},th=0.75`, `${L},th=1`);
  }
  if (kind === "structure") {
    const k = param.split(",")[0] ?? "k=5";
    neighbors.push(`${k},th=0.25`, `${k},th=0.5`, `${k},th=0.75`);
  }
  const signs: number[] = [];
  for (const p of neighbors) {
    const tr = cells.get(cellKey(tf, kind, p, "fade", 0, horizon));
    if (!tr || tr.length < 20) continue;
    signs.push(metricsPurgedOnly(tr).net);
  }
  if (signs.length < 2) return true;
  return signs.filter((x) => x > 0).length >= Math.ceil(signs.length * 0.66);
}

export async function runHunt(): Promise<string> {
  runLeakageSelfTest();

  console.log("\nLoading panels (TRAIN/DEV labels only; sealed entries locked)...");
  const panels = new Map<string, Panel>();
  const m15Panels = new Map<string, Panel>();
  for (const inst of PAIRS) {
    for (const tf of ["H1", "H4", "M15"] as const) {
      const p = await loadPanel(inst, tf);
      if (!p) continue;
      const key = `${inst}|${tf}`;
      if (tf === "M15") m15Panels.set(key, p);
      else panels.set(key, p);
    }
  }

  const preSealed: Zone[] = ["train", "dev"];
  const costLines: string[] = [];
  const costAgg: Record<string, number[]> = { M15: [], H1: [], H4: [] };
  for (const [key, p] of [...m15Panels.entries(), ...panels.entries()]) {
    const st = spreadOverAtr(p, preSealed);
    const tf = key.split("|")[1]!;
    costLines.push(`  ${key}: ${fmtCost(st)}`);
    for (const b of p.bars) {
      if (!preSealed.includes(zoneOf(b.closeTime))) continue;
      if (b.spread != null && b.atr > 0) costAgg[tf]!.push(b.spread / b.atr);
    }
  }
  const costSummary = (tf: string) => {
    const xs = costAgg[tf] ?? [];
    return {
      n: xs.length,
      p25: percentile(xs, 25),
      p50: percentile(xs, 50),
      p75: percentile(xs, 75),
      p90: percentile(xs, 90),
      median: percentile(xs, 50),
    };
  };

  console.log("\nDetecting setups...");
  const allSignals: Signal[] = [];
  for (const p of panels.values()) {
    const sigs = detectAll(p);
    console.log(`  ${p.instrument} ${p.timeframe}: ${sigs.length} raw setup flags`);
    for (const s of sigs) allSignals.push(s);
  }

  // M15 break20 baseline (cost wall check) — TRAIN+DEV only
  const m15Signals: Signal[] = [];
  for (const p of m15Panels.values()) {
    for (const s of detectBreak20(p)) m15Signals.push(s);
  }

  const cells = new Map<CellKey, Trade[]>();
  const kinds = new Map<string, { kind: SetupKind; param: string; timeframe: string }>();

  for (const tf of ["H1", "H4"] as const) {
    const sigTf = allSignals.filter((s) => s.timeframe === tf);
    const bases = new Map<string, { kind: SetupKind; param: string }>();
    for (const s of sigTf) bases.set(`${s.kind}|${s.param}`, { kind: s.kind, param: s.param });
    for (const base of bases.values()) {
      for (const combo of expandCombos(base.kind, base.param)) {
        kinds.set(`${tf}|${combo.kind}|${combo.param}`, { kind: combo.kind, param: combo.param, timeframe: tf });
        const subset = sigTf.filter(
          (s) => s.kind === combo.kind && s.param === combo.baseParam && s.extensionAtr >= combo.minExt,
        );
        for (const side of ["fade", "follow"] as const) {
          for (const horizon of horizonsFor(tf)) {
            const tr = tradesFor(panels, subset, "dev", side, 0, horizon, false);
            cells.set(cellKey(tf, combo.kind, combo.param, side, 0, horizon), tr);
          }
        }
      }
    }
  }

  // TRAIN diagnostics for headline (delay 0)
  const trainCells = new Map<CellKey, Trade[]>();
  for (const tf of ["H1", "H4"] as const) {
    const sigTf = allSignals.filter((s) => s.timeframe === tf);
    const bases = new Map<string, { kind: SetupKind; param: string }>();
    for (const s of sigTf) bases.set(`${s.kind}|${s.param}`, { kind: s.kind, param: s.param });
    for (const base of bases.values()) {
      for (const combo of expandCombos(base.kind, base.param)) {
        if (!headlineParam(combo.kind, combo.param, tf)) continue;
        const subset = sigTf.filter(
          (s) => s.kind === combo.kind && s.param === combo.baseParam && s.extensionAtr >= combo.minExt,
        );
        for (const side of ["fade", "follow"] as const) {
          for (const horizon of horizonsFor(tf)) {
            trainCells.set(
              cellKey(tf, combo.kind, combo.param, side, 0, horizon),
              tradesFor(panels, subset, "train", side, 0, horizon, false),
            );
          }
        }
      }
    }
  }

  function pickHorizon(tf: string): number {
    return tf === "H4" ? 3 : 4;
  }

  const familyKinds: SetupKind[] = ["impulse_1bar", "impulse_multibar", "break20", "structure", "momentum"];

  const sectionFamily = (tf: string, zoneCells: Map<CellKey, Trade[]>, zone: string): string[] => {
    const lines: string[] = [];
    for (const kind of familyKinds) {
      const matches = [...kinds.values()].filter((k) => k.timeframe === tf && k.kind === kind && headlineParam(kind, k.param, tf));
      if (matches.length === 0) {
        lines.push(`${kind}: (no signals or no headline param under objective rules)`);
        continue;
      }
      for (const k of matches) {
        const h = pickHorizon(tf);
        const fade = zoneCells.get(cellKey(tf, k.kind, k.param, "fade", 0, h));
        const follow = zoneCells.get(cellKey(tf, k.kind, k.param, "follow", 0, h));
        const fm = fade ? metricsPurgedOnly(fade) : null;
        const fo = follow ? metricsPurgedOnly(follow) : null;
        lines.push(`${kind} ${k.param} fade@h${h}: ${fm ? fmt(fm) : "n/a"}`);
        lines.push(`    follow: ${fo ? fmt(fo) : "n/a"}`);
        // all horizons fade
        for (const hor of horizonsFor(tf)) {
          const tr = zoneCells.get(cellKey(tf, k.kind, k.param, "fade", 0, hor));
          if (!tr) continue;
          lines.push(`    h=${hor}: ${fmt(metricsPurgedOnly(tr))}`);
        }
      }
    }
    void zone;
    return lines;
  };

  // DEV gate scan (fade only, delay 0)
  type Cand = { tf: string; kind: SetupKind; param: string; horizon: number; trades: Trade[]; metrics: MetricRow };
  const cands: Cand[] = [];
  for (const [key, meta] of kinds) {
    void key;
    const tf = meta.timeframe;
    for (const horizon of horizonsFor(tf)) {
      const tr = cells.get(cellKey(tf, meta.kind, meta.param, "fade", 0, horizon)) ?? [];
      const m = metricsPurgedOnly(tr);
      if (m.effectiveN >= DEV_GATE.minIndependentN && m.net > DEV_GATE.minNet && m.ci95Low > 0) {
        const conc = concentration(tr);
        if (!conc.ok) {
          appendExperiment(
            rowOf({
              zone: "dev",
              instrument: "ALL",
              timeframe: tf,
              kind: meta.kind,
              param: meta.param,
              side: "fade",
              delay: 0,
              horizon,
              trades: tr,
              status: "dev_reject",
              reason: conc.reason,
              sealedTouched: false,
            }),
          );
          continue;
        }
        if (!neighborhoodOk(cells, tf, meta.kind, meta.param, horizon)) {
          appendExperiment(
            rowOf({
              zone: "dev",
              instrument: "ALL",
              timeframe: tf,
              kind: meta.kind,
              param: meta.param,
              side: "fade",
              delay: 0,
              horizon,
              trades: tr,
              status: "dev_reject",
              reason: "neighborhood_not_robust",
              sealedTouched: false,
            }),
          );
          continue;
        }
        cands.push({ tf, kind: meta.kind, param: meta.param, horizon, trades: tr, metrics: m });
        appendExperiment(
          rowOf({
            zone: "dev",
            instrument: "ALL",
            timeframe: tf,
            kind: meta.kind,
            param: meta.param,
            side: "fade",
            delay: 0,
            horizon,
            trades: tr,
            status: "dev_pass",
            reason: "dev_ci_gt_0",
            sealedTouched: false,
          }),
        );
      }
    }
  }

  console.log(`\nDEV candidates with net CI>0: ${cands.length}`);

  let robustBlock = "NOT RUN (no DEV CI>0 candidate)";
  let sealedBlock = "NOT READ (no candidate qualified)";
  let frozenId: string | null = null;
  let bestDev: Cand | null = null;
  let verdict:
    | "H1_REVERSAL_EDGE_FOUND"
    | "H4_REVERSAL_EDGE_FOUND"
    | "PROVISIONAL_REVERSAL_EDGE"
    | "REVERSAL_EXISTS_GROSS_ONLY"
    | "TIMEFRAME_DOES_NOT_FIX_COST_WALL"
    | "NO_REVERSAL_EFFECT"
    | "ROBUSTNESS_REJECT" = "NO_REVERSAL_EFFECT";

  // Simple exits only if a candidate exists
  const exitLines: string[] = [];

  if (cands.length > 0) {
    cands.sort((a, b) => b.metrics.ci95Low - a.metrics.ci95Low);
    bestDev = cands[0]!;
    const spec = {
      timeframe: bestDev.tf,
      kind: bestDev.kind,
      param: bestDev.param,
      delay: 0,
      horizon: bestDev.horizon,
    };
    const sigSub = allSignals.filter((s) => matchExpanded(s, spec.kind, spec.param, spec.timeframe));
    const rob = robustness(bestDev.trades, panels, allSignals, spec);
    robustBlock = JSON.stringify(rob.details, null, 2);
    console.log(`Robustness ok=${rob.ok} for ${bestDev.tf} ${bestDev.kind} ${bestDev.param} h=${bestDev.horizon}`);

    const maxHold = spec.timeframe === "H4" ? 6 : 12;
    for (const [name, fn] of [
      ["1R/1R", () => {
        const out: Trade[] = [];
        for (const s of sigSub) {
          if (zoneOf(s.closeTime) !== "dev") continue;
          const p = panels.get(`${s.instrument}|${s.timeframe}`);
          if (!p) continue;
          const t = labelRExit({ panel: p, signal: s, side: "fade", delay: 0, targetR: 1, stopR: 1, maxHold, allowSealed: false });
          if (t) out.push(t);
        }
        return out;
      }],
      ["1.5R/1R", () => {
        const out: Trade[] = [];
        for (const s of sigSub) {
          if (zoneOf(s.closeTime) !== "dev") continue;
          const p = panels.get(`${s.instrument}|${s.timeframe}`);
          if (!p) continue;
          const t = labelRExit({ panel: p, signal: s, side: "fade", delay: 0, targetR: 1.5, stopR: 1, maxHold, allowSealed: false });
          if (t) out.push(t);
        }
        return out;
      }],
      ["retrace50", () => {
        const out: Trade[] = [];
        for (const s of sigSub) {
          if (zoneOf(s.closeTime) !== "dev") continue;
          const p = panels.get(`${s.instrument}|${s.timeframe}`);
          if (!p) continue;
          const t = labelRetraceExit({ panel: p, signal: s, side: "fade", delay: 0, retraceFrac: 0.5, maxHold, allowSealed: false });
          if (t) out.push(t);
        }
        return out;
      }],
    ] as Array<[string, () => Trade[]]>) {
      const tr = fn();
      exitLines.push(`  ${name}: ${fmt(metricsPurgedOnly(tr))}`);
    }

    if (!rob.ok) {
      verdict = "ROBUSTNESS_REJECT";
      appendExperiment(
        rowOf({
          zone: "dev",
          instrument: "ALL",
          timeframe: spec.timeframe,
          kind: spec.kind,
          param: spec.param,
          side: "fade",
          delay: 0,
          horizon: spec.horizon,
          trades: bestDev.trades,
          status: "robustness_reject",
          reason: "robustness_failed",
          sealedTouched: false,
        }),
      );
    } else {
      frozenId = "reversal-fade-h1h4-candidate-001";
      freezeCandidate(frozenId, {
        id: frozenId,
        status: "SHADOW_ONLY",
        spec,
        dev: metricsPurgedOnly(bestDev.trades),
        robustness: rob.details,
        frozenAt: new Date().toISOString(),
        slippagePips: SLIPPAGE_PIPS,
        zones: ZONES,
      });
      // Sealed once
      const sealedTrades = tradesFor(panels, sigSub, "sealed", "fade", 0, spec.horizon, true);
      const sm = metricsPurgedOnly(sealedTrades);
      sealedBlock = fmt(sm) + `\n  byPair=${JSON.stringify(pairNet(sealedTrades))}`;
      const pass = sm.effectiveN >= 30 && sm.ci95Low > 0;
      appendExperiment(
        rowOf({
          zone: "sealed",
          instrument: "ALL",
          timeframe: spec.timeframe,
          kind: spec.kind,
          param: spec.param,
          side: "fade",
          delay: 0,
          horizon: spec.horizon,
          trades: sealedTrades,
          status: pass ? "sealed_pass" : "sealed_fail",
          reason: pass ? "sealed_ci_gt_0" : `sealed ${fmt(sm)}`,
          sealedTouched: true,
        }),
      );
      if (pass) {
        verdict = spec.timeframe === "H4" ? "H4_REVERSAL_EDGE_FOUND" : "H1_REVERSAL_EDGE_FOUND";
      } else {
        verdict = "PROVISIONAL_REVERSAL_EDGE";
      }
    }
  } else {
    // Classify: gross-only vs no effect vs cost wall
    let anyGross = false;
    let anyGrossCi = false;
    let anyNetPos = false;
    for (const tf of ["H1", "H4"] as const) {
      for (const kind of familyKinds) {
        const matches = [...kinds.values()].filter((k) => k.timeframe === tf && k.kind === kind && headlineParam(kind, k.param, tf));
        for (const k of matches) {
          const tr = cells.get(cellKey(tf, k.kind, k.param, "fade", 0, pickHorizon(tf))) ?? [];
          const m = metricsPurgedOnly(tr);
          if (m.gross > 0) anyGross = true;
          if (m.gross > 0 && m.ci95Low > 0) anyGrossCi = true;
          if (m.net > 0) anyNetPos = true;
        }
      }
    }
    if (anyNetPos) verdict = "PROVISIONAL_REVERSAL_EDGE";
    else if (anyGrossCi || anyGross) {
      const m15fade = tradesFor(
        m15Panels,
        m15Signals,
        "dev",
        "fade",
        0,
        4,
        false,
      );
      const m15m = metricsPurgedOnly(m15fade);
      verdict = m15m.net < 0 || anyGross ? "TIMEFRAME_DOES_NOT_FIX_COST_WALL" : "REVERSAL_EXISTS_GROSS_ONLY";
      if (anyGross && !anyNetPos) verdict = "TIMEFRAME_DOES_NOT_FIX_COST_WALL";
    } else {
      verdict = "NO_REVERSAL_EFFECT";
    }
  }

  // Continuation vs reversal headline
  const contRev = (tf: string): string => {
    const h = pickHorizon(tf);
    const lines: string[] = [];
    for (const kind of familyKinds) {
      const matches = [...kinds.values()].filter((k) => k.timeframe === tf && k.kind === kind && headlineParam(kind, k.param, tf));
      for (const k of matches) {
        const fade = cells.get(cellKey(tf, k.kind, k.param, "fade", 0, h));
        const fol = cells.get(cellKey(tf, k.kind, k.param, "follow", 0, h));
        lines.push(`  ${kind} ${k.param}: fade ${fade ? fmt(metricsPurgedOnly(fade)) : "n/a"}`);
        lines.push(`                 follow ${fol ? fmt(metricsPurgedOnly(fol)) : "n/a"}`);
      }
    }
    return lines.join("\n");
  };

  // Extension buckets: unique-ish from loosest impulse + break20 fade h=primary
  const extLines: string[] = [];
  for (const tf of ["H1", "H4"] as const) {
    const h = pickHorizon(tf);
    const pool: Trade[] = [];
    for (const [ck, tr] of cells) {
      if (!ck.startsWith(`${tf}|`)) continue;
      if (!ck.includes("|fade|d0|h" + h)) continue;
      if (!ck.includes("impulse_1bar|th=0.2") && !ck.includes("|break20|")) continue;
      pool.push(...tr);
    }
    extLines.push(`${tf} fade pooled (impulse≥0.2 + break20) h=${h}:`);
    const g = groupBy(pool, (t) => bucketExt(t.extensionAtr));
    const nets: number[] = [];
    for (const b of EXT_BUCKETS) {
      const arr = g.get(b) ?? [];
      const m = metricsPurgedOnly(arr);
      extLines.push(`  ${b}: ${arr.length === 0 ? "empty" : fmt(m) + ` MFE=${mean(arr.map((t) => t.mfeAtr)).toFixed(3)} MAE=${mean(arr.map((t) => t.maeAtr)).toFixed(3)}`}`);
      if (arr.length >= 30) nets.push(m.gross);
    }
    let extAns = "NO";
    if (nets.length >= 3 && nets[nets.length - 1]! > nets[0]!) extAns = "PARTIALLY";
    if (nets.length >= 3 && nets.every((v, i) => i === 0 || v >= nets[i - 1]! - 0.02)) extAns = "YES";
    extLines.push(`  Larger extension → stronger reversal? ${extAns}`);
  }

  const ls = (tf: string): string => {
    const h = pickHorizon(tf);
    const lines: string[] = [];
    for (const kind of ["break20", "impulse_1bar"] as SetupKind[]) {
      const matches = [...kinds.values()].filter((k) => k.timeframe === tf && k.kind === kind && headlineParam(kind, k.param, tf));
      for (const k of matches) {
        const tr = cells.get(cellKey(tf, k.kind, k.param, "fade", 0, h)) ?? [];
        const L = tr.filter((t) => t.direction === "long");
        const S = tr.filter((t) => t.direction === "short");
        lines.push(`  ${kind} LONG fade: ${fmt(metricsPurgedOnly(L))}`);
        lines.push(`  ${kind} SHORT fade: ${fmt(metricsPurgedOnly(S))}`);
      }
    }
    return lines.join("\n");
  };

  const pairBlock = (tf: string): string => {
    const h = pickHorizon(tf);
    const lines: string[] = [];
    for (const inst of PAIRS) {
      lines.push(`  ${inst}:`);
      for (const kind of familyKinds) {
        const matches = [...kinds.values()].filter((k) => k.timeframe === tf && k.kind === kind && headlineParam(kind, k.param, tf));
        for (const k of matches) {
          const tr = (cells.get(cellKey(tf, k.kind, k.param, "fade", 0, h)) ?? []).filter((t) => t.instrument === inst);
          lines.push(`    ${kind}: ${fmt(metricsPurgedOnly(tr))}`);
        }
      }
    }
    return lines.join("\n");
  };

  // Reversal timing
  const timingLines: string[] = [];
  for (const tf of ["H1", "H4"] as const) {
    const h = pickHorizon(tf);
    const tr = cells.get(
      cellKey(
        tf,
        "break20",
        "n=20",
        "fade",
        0,
        h,
      ),
    ) ?? [];
    const bins = { 1: 0, 2: 0, 4: 0, later: 0, never: 0 };
    for (const t of tr) {
      const lag = t.reversalLag;
      if (lag == null) bins.never += 1;
      else if (lag <= 1) bins[1] += 1;
      else if (lag <= 2) bins[2] += 1;
      else if (lag <= 4) bins[4] += 1;
      else bins.later += 1;
    }
    const n = tr.length || 1;
    timingLines.push(
      `${tf} break20 fade: within1=${(bins[1] / n).toFixed(2)} within2=${(bins[2] / n).toFixed(2)} within4=${(bins[4] / n).toFixed(2)} later=${(bins.later / n).toFixed(2)} never=${(bins.never / n).toFixed(2)} avgRetrace=${mean(tr.map((t) => t.retracePct ?? 0)).toFixed(2)}`,
    );
  }

  // Vol regimes
  const volLines: string[] = [];
  for (const tf of ["H1", "H4"] as const) {
    const h = pickHorizon(tf);
    const tr = cells.get(cellKey(tf, "break20", "n=20", "fade", 0, h)) ?? [];
    for (const vb of ["low", "normal", "high", "extreme"] as const) {
      const sub = tr.filter((t) => t.volBucket === vb);
      volLines.push(`  ${tf} ${vb}: ${fmt(metricsPurgedOnly(sub))}`);
    }
  }

  // Sessions H1
  const sessLines: string[] = [];
  {
    const tr = cells.get(cellKey("H1", "break20", "n=20", "fade", 0, 4)) ?? [];
    for (const s of ["asia", "london", "overlap", "newyork"] as const) {
      sessLines.push(`  ${s}: ${fmt(metricsPurgedOnly(tr.filter((t) => t.session === s)))}`);
    }
  }

  // Retracement buckets
  const retrLines: string[] = [];
  for (const tf of ["H1", "H4"] as const) {
    const h = pickHorizon(tf);
    const tr = cells.get(cellKey(tf, "break20", "n=20", "fade", 0, h)) ?? [];
    const rb = (p: number | null) => {
      if (p == null) return "na";
      if (p < 0.2) return "<20%";
      if (p < 0.33) return "20-33%";
      if (p < 0.5) return "33-50%";
      if (p < 0.67) return "50-67%";
      return ">67%";
    };
    const g = groupBy(tr, (t) => rb(t.retracePct));
    retrLines.push(`${tf}:`);
    for (const b of ["<20%", "20-33%", "33-50%", "50-67%", ">67%"]) {
      retrLines.push(`  ${b}: n=${(g.get(b) ?? []).length}`);
    }
  }

  // M15 baseline
  const m15fadeDev = tradesFor(m15Panels, m15Signals, "dev", "fade", 0, 4, false);
  const m15folDev = tradesFor(m15Panels, m15Signals, "dev", "follow", 0, 4, false);

  const cM15 = costSummary("M15");
  const cH1 = costSummary("H1");
  const cH4 = costSummary("H4");

  const coverage = (tf: string) => {
    const ps = [...(tf === "M15" ? m15Panels : panels).values()].filter((p) => p.timeframe === tf);
    return ps
      .map((p) => {
        const times = p.bars.map((b) => b.closeTime);
        return `${p.instrument} n=${p.bars.length} ${times[0]} → ${times[times.length - 1]}`;
      })
      .join("\n  ");
  };

  const bestBlock = bestDev
    ? `Timeframe: ${bestDev.tf}
Setup: ${bestDev.kind} ${bestDev.param}
Extension: (see param)
Entry: delay 0 (signal close)
Exit: fixed ${bestDev.horizon} bars

n: ${bestDev.metrics.n}
effective n: ${bestDev.metrics.effectiveN}

Gross expectancy: ${bestDev.metrics.gross.toFixed(4)} ATR
Net expectancy: ${bestDev.metrics.net.toFixed(4)} ATR
Net 95% CI: [${bestDev.metrics.ci95Low.toFixed(4)}, ${bestDev.metrics.ci95High.toFixed(4)}]
Profit factor: ${bestDev.metrics.profitFactor.toFixed(3)}`
    : "None (no DEV cell with purged net CI entirely > 0)";

  const report = `GOLDENXPERIENCE
H1/H4 REVERSAL EDGE TEST
strategy: ${STRATEGY_VERSION}

========================================
DATA
========================================

Pairs: ${PAIRS.join(", ")}
H1 date coverage:
  ${coverage("H1")}
H4 date coverage:
  ${coverage("H4")}
M15 (baseline only):
  ${coverage("M15")}

TRAIN: ${ZONES.trainStart} → ${ZONES.trainEnd}
DEV:   ${ZONES.devStart} → ${ZONES.devEnd}
SEALED STATUS: ${frozenId ? "READ after freeze " + frozenId : "NOT READ"}

Prior M15 (preserved, not re-mined): ${M15_PRIOR.setup} gross≈${M15_PRIOR.grossAtr} ATR net≈${M15_PRIOR.netAtr} ATR

M15 break20 DEV baseline h=4: fade ${fmt(metricsPurgedOnly(m15fadeDev))}
                              follow ${fmt(metricsPurgedOnly(m15folDev))}

========================================
COST COMPARISON (TRAIN+DEV, spread/ATR)
========================================

M15 spread/ATR: ${fmtCost(cM15)}
H1  spread/ATR: ${fmtCost(cH1)}
H4  spread/ATR: ${fmtCost(cH4)}

Per instrument:
${costLines.join("\n")}

========================================
H1 RESULTS (DEV, delay=0, headline params, purged CI)
========================================

${sectionFamily("H1", cells, "dev").join("\n")}

TRAIN headline (context, not for promotion):
${sectionFamily("H1", trainCells, "train").join("\n")}

========================================
H4 RESULTS (DEV, delay=0, headline params, purged CI)
========================================

${sectionFamily("H4", cells, "dev").join("\n")}

TRAIN headline:
${sectionFamily("H4", trainCells, "train").join("\n")}

========================================
CONTINUATION VS REVERSAL (DEV)
========================================

H1:
${contRev("H1")}

H4:
${contRev("H4")}

========================================
EXTENSION EFFECT (DEV)
========================================

${extLines.join("\n")}

========================================
REVERSAL TIMING / RETRACEMENT (outcome, not features)
========================================

${timingLines.join("\n")}

Retracement depth of impulse (break20 fade):
${retrLines.join("\n")}

========================================
VOLATILITY REGIMES (break20 fade DEV)
========================================

${volLines.join("\n")}

========================================
H1 SESSIONS (break20 fade h=4)
========================================

${sessLines.join("\n")}

========================================
LONG / SHORT (DEV fade)
========================================

H1:
${ls("H1")}

H4:
${ls("H4")}

========================================
PAIR RESULTS (DEV fade)
========================================

H1:
${pairBlock("H1")}

H4:
${pairBlock("H4")}

========================================
BEST DEV CANDIDATE
========================================

${bestBlock}

Optional exits (only if a CI>0 candidate existed):
${exitLines.length ? exitLines.join("\n") : "  skipped"}

========================================
ROBUSTNESS
========================================

${robustBlock}

========================================
SEALED
========================================

${sealedBlock}

========================================
LEAKAGE AUDIT
========================================

H1/H4 candle completion: PASS (signals on closed bars)
Bid/ask alignment: PASS (skip if quote missing)
Breakout level lookahead: PASS (self-test: prior window excludes bar i)
Swing confirmation: PASS (right-side k bars required)
ATR: PASS (through completed signal bar)
Execution prices: PASS (ask/bid by direction + ${SLIPPAGE_PIPS} pip slip)
Label overlap: PASS (CI uses purged stride = hold)
Train/dev boundaries: PASS (horizon embargo at zone end; sealed locked)
MFE/MAE not in features: PASS
LIVE_EXECUTABLE_FAMILIES: untouched []

========================================
FINAL VERDICT
========================================

${verdict}
`;

  writeReport(report);
  console.log(report);
  return report;
}
