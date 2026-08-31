/**
 * eurusd-exogenous-v1 — does EXTERNAL market information provide EUR/USD
 * directional edge on the FROZEN eurusd-move-v1 MOVE_LIKELY windows?
 *
 * Frozen (imported, not re-tuned): MOVE label = reach ≥ 3.0 ATR @ 24h; dev/
 * sealed split (sealed = 2026-05-01→); expanding 6-fold walk-forward w/ 72h
 * embargo; direction labels (dominant excursion primary, terminal secondary);
 * coverage buckets. Only the DIRECTION feature source changes: exogenous
 * cross-FX / synthetic-USD-basket / gold, in grouped ablations.
 *
 * Rates, CB-expectations, equities/VIX, COT, order-flow: absent on disk
 * (see DATA_INVENTORY.md) → not tested. Emits RESULTS.json.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadCandles, resampleUp, PIP, REPO_ROOT, type Bar } from "../eurusdbot3-1/data.js";
import { buildContext, buildRawFeatures, FEATURE_NAMES, type Ctx } from "../eurusdbot3-1/features.js";
import { resolveOutcome } from "../eurusdbot3-1/barrier.js";
import { trainLogit, predictProb, type Sample } from "../eurusdbot3-1/model.js";
import { wilsonLower, summarize, type Trade } from "../eurusdbot3-1/metrics.js";
import { measureExcursion, type Excursion } from "../eurusd-move-v1/excursion.js";
import { ExoStore } from "./exo-data.js";
import { buildExoFeatures, usdStrength, eurStrength, FAMILIES } from "./exo-features.js";

// ---- Frozen config (from eurusd-move-v1) ----------------------------------
const WARMUP = 520;
const SEALED_START = Date.parse("2026-05-01T00:00:00.000Z");
const MOVE_HORIZON = 24;
const MOVE_THR = 3.0;              // frozen balance-selected MOVE threshold
const DIR_HORIZON = 24;
const COVERAGES = [1.0, 0.75, 0.5, 0.3, 0.2, 0.1, 0.05];
const FOLDS = 6;
const H72 = 72 * 3_600_000;
const SLIPPAGE_PIPS = 0.5;

const OUT = path.join(REPO_ROOT, "api-server", "research", "eurusd-exogenous-v1");
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(...a);
const rng = (s: number) => () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

type Cand = { i: number; t: number; iso: string; exc: Excursion; exo: Record<string, number>; internal: Record<string, number>; hourUtc: number; session: string; atrPct: number };

// ---- stats helpers ---------------------------------------------------------
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function binom(correct: number, n: number) { if (!n) return { acc: 0, z: 0, p: 1 }; const acc = correct / n; const z = (correct - n / 2) / Math.sqrt(n / 4); return { acc: +acc.toFixed(4), z: +z.toFixed(2), p: +(2 * (1 - phi(Math.abs(z)))).toFixed(4) }; }
function corr(a: number[], b: number[]) { const n = a.length; if (n < 2) return 0; const ma = mean(a), mb = mean(b); let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const da = a[i]! - ma, db = b[i]! - mb; sab += da * db; sa += da * da; sb += db * db; } return sa && sb ? +(sab / Math.sqrt(sa * sb)).toFixed(3) : 0; }
function rocAuc(scores: number[], labels: number[]) { const idx = scores.map((_, k) => k).sort((x, y) => scores[x]! - scores[y]!); const ranks = new Array<number>(scores.length); let k = 0; while (k < idx.length) { let j = k; while (j + 1 < idx.length && scores[idx[j + 1]!]! === scores[idx[k]!]!) j++; const r = (k + j) / 2 + 1; for (let m = k; m <= j; m++) ranks[idx[m]!] = r; k = j + 1; } let sp = 0, np = 0, nn = 0; for (let m = 0; m < labels.length; m++) { if (labels[m]) { sp += ranks[m]!; np++; } else nn++; } return np && nn ? +((sp - np * (np + 1) / 2) / (np * nn)).toFixed(4) : 0.5; }

// ---- labels ----------------------------------------------------------------
const moveLikely = (c: Cand) => c.exc.byH[MOVE_HORIZON]!.reachATR >= MOVE_THR;
const labUp = (c: Cand, h = DIR_HORIZON) => (c.exc.byH[h]!.mfeUpATR >= -c.exc.byH[h]!.maeDownATR ? 1 : 0); // dominant excursion
const labTerm = (c: Cand, h = DIR_HORIZON) => (c.exc.byH[h]!.retATR >= 0 ? 1 : 0);

// ---- walk-forward direction (returns OOS p(up) per candidate + per-window acc)
function wfDirection(dev: Cand[], featOf: (c: Cand) => Record<string, number>, featNames: string[], labelOf: (c: Cand) => number) {
  const t0 = dev[0]!.t, tN = dev.at(-1)!.t, span = tN - t0, ff = 0.35, ts = (span * (1 - ff)) / FOLDS;
  const probByIso = new Map<string, number>();
  const windows: Array<{ window: number; testStart: string; n: number; acc: number }> = [];
  const foldCoefSigns: Array<Record<string, number>> = [];
  for (let f = 0; f < FOLDS; f++) {
    const testStart = t0 + span * ff + f * ts, testEnd = f === FOLDS - 1 ? tN + 1 : testStart + ts;
    const train = dev.filter((c) => c.t < testStart - H72 && moveLikely(c));
    if (train.length < 400) continue;
    const model = trainLogit(train.map((c) => ({ x: featOf(c), y: labelOf(c) } as Sample)), featNames, { l2: 2.0, lr: 0.2, epochs: 200 });
    foldCoefSigns.push(Object.fromEntries(featNames.map((k) => [k, Math.sign(model.coef[k] ?? 0)])));
    const test = dev.filter((c) => c.t >= testStart && c.t < testEnd && moveLikely(c));
    let ok = 0;
    for (const c of test) { const p = predictProb(model, featOf(c)); probByIso.set(c.iso, p); if ((p >= 0.5 ? 1 : 0) === labelOf(c)) ok++; }
    windows.push({ window: f + 1, testStart: new Date(testStart).toISOString().slice(0, 10), n: test.length, acc: test.length ? +(ok / test.length).toFixed(4) : 0 });
  }
  return { probByIso, windows, foldCoefSigns };
}

function accByCoverage(set: Cand[], probByIso: Map<string, number>, labelOf: (c: Cand) => number, atrPips: (c: Cand) => number) {
  const rows = set.filter((c) => probByIso.has(c.iso)).map((c) => {
    const p = probByIso.get(c.iso)!, pred = p >= 0.5 ? 1 : 0, conf = Math.abs(p - 0.5) * 2;
    const h = c.exc.byH[DIR_HORIZON]!;
    const mfe = pred === 1 ? h.mfeUpATR : -h.maeDownATR, mae = pred === 1 ? -h.maeDownATR : h.mfeUpATR;
    const signedPips = (pred === 1 ? h.retATR : -h.retATR) * atrPips(c);
    return { conf, correct: pred === labelOf(c) ? 1 : 0, up: pred, signedPips, mfe, mae };
  });
  rows.sort((a, b) => b.conf - a.conf);
  const out: Record<string, unknown> = {};
  for (const cov of COVERAGES) {
    const s = rows.slice(0, Math.max(1, Math.round(rows.length * cov)));
    const up = s.filter((r) => r.up === 1).length, correct = s.reduce((a, r) => a + r.correct, 0);
    const bt = binom(correct, s.length);
    const amfe = mean(s.map((r) => r.mfe)), amae = mean(s.map((r) => r.mae));
    out[`${Math.round(cov * 100)}%`] = { n: s.length, up, down: s.length - up, accuracy: bt.acc, p: bt.p, wilsonLo: +wilsonLower(correct, s.length).toFixed(4), avgSignedPips: +mean(s.map((r) => r.signedPips)).toFixed(2), avgMFE: +amfe.toFixed(3), avgMAE: +amae.toFixed(3), mfeMae: +(amfe / (amae || 1)).toFixed(2) };
  }
  return out;
}
function acc(set: Cand[], pick: (c: Cand) => 0 | 1, labelOf: (c: Cand) => number) { let ok = 0; for (const c of set) if (pick(c) === labelOf(c)) ok++; const b = binom(ok, set.length); return { n: set.length, accuracy: b.acc, p: b.p }; }

async function main() {
  const started = Date.now();
  log("Loading EUR/USD + exogenous…");
  const h1 = loadCandles("H1"), m15 = loadCandles("M15");
  const h4 = resampleUp(h1, 4), daily = resampleUp(h1, 24);
  const exo = new ExoStore();
  const ctx: Ctx = buildContext(h1, m15);

  log("Building candidates (freezing MOVE detector)…");
  const cands: Cand[] = [];
  const lastLabel = h1.at(-1)!.t - H72;
  for (let i = WARMUP; i < h1.length; i++) {
    if (h1[i]!.t > lastLabel) break;
    const exc = measureExcursion(h1, m15, i, ctx.atr[i]!); if (!exc) continue;
    const hourUtc = new Date(h1[i]!.t).getUTCHours();
    const session = hourUtc >= 12 && hourUtc < 16 ? "overlap" : hourUtc >= 7 && hourUtc < 12 ? "london" : hourUtc >= 16 && hourUtc < 21 ? "ny" : "asia";
    cands.push({ i, t: h1[i]!.t, iso: h1[i]!.iso, exc, exo: buildExoFeatures(exo, h1[i]!.t), internal: buildRawFeatures(ctx, i, h4, daily), hourUtc, session, atrPct: ctx.atr[i]! ? 0 : 0 });
  }
  for (const c of cands) c.atrPct = c.internal.atr_pct ?? 0.5;
  const dev = cands.filter((c) => c.t < SEALED_START), sealed = cands.filter((c) => c.t >= SEALED_START);
  const devMove = dev.filter(moveLikely), sealedMove = sealed.filter(moveLikely);
  const atrPipsOf = (c: Cand) => c.exc.atrPips;
  log(`  candidates=${cands.length} dev=${dev.length} sealed=${sealed.length} | MOVE_LIKELY dev=${devMove.length} sealed=${sealedMove.length} (base rate ${(devMove.length / dev.length * 100).toFixed(1)}%)`);

  // ============ FAMILY ABLATIONS (exogenous only) ============
  log("Family ablations…");
  const families: Record<string, unknown> = {};
  const familyProb: Record<string, Map<string, number>> = {};
  for (const [name, feats] of Object.entries(FAMILIES)) {
    const wf = wfDirection(dev, (c) => c.exo, feats, (c) => labUp(c));
    familyProb[name] = wf.probByIso;
    const evalSet = devMove.filter((c) => wf.probByIso.has(c.iso));
    const correct = evalSet.reduce((a, c) => a + ((wf.probByIso.get(c.iso)! >= 0.5 ? 1 : 0) === labUp(c) ? 1 : 0), 0);
    const bt = binom(correct, evalSet.length);
    const auc = rocAuc(evalSet.map((c) => wf.probByIso.get(c.iso)!), evalSet.map((c) => labUp(c)));
    families[name] = { features: feats.length, oosAcc: bt.acc, p: bt.p, wilsonLo: +wilsonLower(correct, evalSet.length).toFixed(4), auc, n: evalSet.length, windows: wf.windows };
  }
  // Combined exogenous + internal (§13)
  const wfCombined = wfDirection(dev, (c) => ({ ...c.exo, ...c.internal }), [...FAMILIES.ALL_EXO!, ...FEATURE_NAMES], (c) => labUp(c));
  // Internal-only (prior price/vol/news direction model — the move-v1/eurusdbot3-1 family baseline)
  const wfInternal = wfDirection(dev, (c) => c.internal, FEATURE_NAMES, (c) => labUp(c));

  // ============ PRIMARY (ALL_EXO) detailed coverage + terminal label ============
  const primaryProb = familyProb.ALL_EXO!;
  const primary = {
    label: "dominantExcursion@24h", family: "ALL_EXO",
    accuracyByCoverage: accByCoverage(devMove, primaryProb, (c) => labUp(c), atrPipsOf),
    accuracyByCoverage_terminal: accByCoverage(devMove, primaryProb, (c) => labTerm(c), atrPipsOf),
  };
  const combined = { accuracyByCoverage: accByCoverage(devMove, wfCombined.probByIso, (c) => labUp(c), atrPipsOf) };
  const internalOnly = { accuracyByCoverage: accByCoverage(devMove, wfInternal.probByIso, (c) => labUp(c), atrPipsOf) };

  // ============ BASELINES (identical MOVE_LIKELY OOS timestamps) ============
  log("Baselines…");
  const evalSet = devMove.filter((c) => primaryProb.has(c.iso));
  const rnd = rng(7);
  const baselines: Record<string, unknown> = {
    exogenous_ALL: acc(evalSet, (c) => (primaryProb.get(c.iso)! >= 0.5 ? 1 : 0), (c) => labUp(c)),
    combined_exo_internal: acc(evalSet.filter((c) => wfCombined.probByIso.has(c.iso)), (c) => (wfCombined.probByIso.get(c.iso)! >= 0.5 ? 1 : 0), (c) => labUp(c)),
    internal_prior_model: acc(evalSet.filter((c) => wfInternal.probByIso.has(c.iso)), (c) => (wfInternal.probByIso.get(c.iso)! >= 0.5 ? 1 : 0), (c) => labUp(c)),
    random: acc(evalSet, () => (rnd() < 0.5 ? 1 : 0) as 0 | 1, (c) => labUp(c)),
    alwaysUp: acc(evalSet, () => 1, (c) => labUp(c)),
    alwaysDown: acc(evalSet, () => 0, (c) => labUp(c)),
    simple_DXY_inverse: acc(evalSet, (c) => (c.exo.usd_ret_4! < 0 ? 1 : 0), (c) => labUp(c)), // USD weak → EURUSD up
    simple_crossfx_strength: acc(evalSet, (c) => (c.exo.sdiff_4! > 0 ? 1 : 0), (c) => labUp(c)),
    simple_rate_diff: { n: 0, accuracy: null, p: null, note: "no intraday rate data on disk — INSUFFICIENT_DATA" },
  };

  // ============ LEAD-LAG: correlation vs forward prediction (§16-17) ============
  log("Lead-lag / correlation vs prediction…");
  const usdFwd = (t: number, h: number) => { const a = usdStrength(exo, t + h * 3_600_000, h); return a; }; // USD basket ret over (t, t+h]
  const eurusdFwd = (c: Cand, h: number) => c.exc.byH[h]!.retATR; // signed terminal return in ATR
  const contempEUR: number[] = [], contempUSD: number[] = [];
  for (const c of evalSet) { contempEUR.push(eurusdFwd(c, 24)); contempUSD.push(usdFwd(c.t, 24)); }
  const leadLag: Record<string, unknown> = {
    contemporaneous_corr_EURUSD_vs_USDbasket_over_next24h: corr(contempEUR, contempUSD),
    note: "strong negative contemporaneous corr is expected/tautological; forward test below uses only PAST info",
    forward_accuracy_usd_inverse_by_lookback: Object.fromEntries([1, 2, 4, 8, 24].map((k) => {
      const a = acc(evalSet, (c) => (usdStrength(exo, c.t, k) < 0 ? 1 : 0), (c) => labUp(c));
      return [`past_${k}h`, a];
    })),
    forward_accuracy_strengthdiff_by_lookback: Object.fromEntries([1, 2, 4, 8, 24].map((k) => {
      const a = acc(evalSet, (c) => ((eurStrength(exo, c.t, k) - usdStrength(exo, c.t, k)) > 0 ? 1 : 0), (c) => labUp(c));
      return [`past_${k}h`, a];
    })),
    NONCAUSAL_reference_contemporaneous_usd_inverse: acc(evalSet, (c) => (usdFwd(c.t, 24) < 0 ? 1 : 0), (c) => labUp(c)),
  };

  // ============ TEMPORAL STABILITY (per-window acc, ALL_EXO) ============
  const temporalStability = (families.ALL_EXO as { windows: unknown }).windows;

  // ============ REGIME BREAKDOWN ============
  log("Regime breakdown…");
  const regimeSets: Record<string, Cand[]> = {
    lowVol: evalSet.filter((c) => c.atrPct < 0.33), normalVol: evalSet.filter((c) => c.atrPct >= 0.33 && c.atrPct < 0.66), highVol: evalSet.filter((c) => c.atrPct >= 0.66),
    london: evalSet.filter((c) => c.session === "london"), ny: evalSet.filter((c) => c.session === "ny"), overlap: evalSet.filter((c) => c.session === "overlap"), asia: evalSet.filter((c) => c.session === "asia"),
  };
  const regimes: Record<string, unknown> = {};
  for (const [k, set] of Object.entries(regimeSets)) regimes[k] = acc(set, (c) => (primaryProb.get(c.iso)! >= 0.5 ? 1 : 0), (c) => labUp(c));

  // ============ FEATURE SIGN STABILITY (ALL_EXO across folds) ============
  const wfAll = wfDirection(dev, (c) => c.exo, FAMILIES.ALL_EXO!, (c) => labUp(c));
  const signStability: Record<string, { plus: number; minus: number; stable: boolean }> = {};
  for (const f of FAMILIES.ALL_EXO!) {
    const signs = wfAll.foldCoefSigns.map((s) => s[f] ?? 0);
    const plus = signs.filter((s) => s > 0).length, minus = signs.filter((s) => s < 0).length;
    signStability[f] = { plus, minus, stable: plus === 0 || minus === 0 };
  }

  // ============ SEALED (freeze ALL_EXO exogenous-only; run once) ============
  log("Sealed test…");
  const sealedModel = trainLogit(devMove.map((c) => ({ x: c.exo, y: labUp(c) } as Sample)), FAMILIES.ALL_EXO!, { l2: 2.0, lr: 0.2, epochs: 200 });
  const sealedProb = new Map<string, number>(); for (const c of sealedMove) sealedProb.set(c.iso, predictProb(sealedModel, c.exo));
  const sealedCorrect = sealedMove.reduce((a, c) => a + ((sealedProb.get(c.iso)! >= 0.5 ? 1 : 0) === labUp(c) ? 1 : 0), 0);
  const sealedResult = {
    n: sealedMove.length, ...binom(sealedCorrect, sealedMove.length),
    auc: rocAuc(sealedMove.map((c) => sealedProb.get(c.iso)!), sealedMove.map((c) => labUp(c))),
    accuracyByCoverage: accByCoverage(sealedMove, sealedProb, (c) => labUp(c), atrPipsOf),
  };

  // ============ TRADE TEST (gated; reported as evidence) ============
  log("Trade test (frozen ALL_EXO predictions, NET)…");
  const topConf = [...evalSet].map((c) => ({ c, conf: Math.abs(primaryProb.get(c.iso)! - 0.5) * 2, p: primaryProb.get(c.iso)! })).sort((a, b) => b.conf - a.conf).slice(0, Math.max(1, Math.round(evalSet.length * 0.2)));
  const rrSim: Record<string, unknown> = {};
  for (const tp of [1, 1.25, 1.5, 2, 2.5, 3]) {
    const trades: Trade[] = [];
    for (const { c, p } of topConf) {
      const dir = p >= 0.5 ? "long" : "short";
      const o = resolveOutcome({ direction: dir, entryH1: h1[c.i]!, riskDistance: Math.max(1.0 * c.exc.atr, 5 * PIP), tpR: tp, horizonMs: H72, m15, slippagePips: SLIPPAGE_PIPS, cost: "net" });
      trades.push({ time: c.iso, direction: dir, r: o.r, cls: o.cls, holdMs: o.holdMs, conf: 0.5 });
    }
    const s = summarize(trades);
    rrSim[`1:${tp}`] = { trades: s.trades, winRate: +s.winRate.toFixed(3), netExpectancy: +s.expectancy.toFixed(3), totalR: +s.totalR.toFixed(1), pf: +(s.profitFactor || 0).toFixed(2) };
  }

  const results = {
    generatedAt: new Date().toISOString(), runtimeSec: +((Date.now() - started) / 1000).toFixed(1),
    rerun: "cd api-server && npx tsx scripts/eurusd-exogenous-v1/experiment.ts",
    frozenConfig: { WARMUP, SEALED_START: new Date(SEALED_START).toISOString(), MOVE_HORIZON, MOVE_THR, DIR_HORIZON, FOLDS, note: "MOVE detector + split + WF + labels frozen from eurusd-move-v1" },
    data: { instrument: "EUR_USD", h1: h1.length, m15: m15.length, exogenousUsable: ["USD_JPY", "USD_CHF", "USD_CAD", "GBP_USD", "AUD_USD", "NZD_USD", "EUR_GBP", "EUR_JPY", "XAU_USD"], unavailable: ["intraday rates", "CB rate expectations", "equities/VIX", "COT", "order-flow"], candidates: cands.length, dev: dev.length, sealed: sealed.length, moveLikelyDev: devMove.length, moveLikelySealed: sealedMove.length },
    familyAblations: families,
    primaryExogenous: primary,
    combinedExoInternal: combined,
    internalPriorOnly: internalOnly,
    baselines,
    leadLag,
    temporalStability,
    regimes,
    featureSignStability: signStability,
    sealed: sealedResult,
    tradeTest_frozen: rrSim,
  };
  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(results, null, 2));
  log(`\nWrote ${path.join(OUT, "RESULTS.json")} (${results.runtimeSec}s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
