import { EDGE_GATES, HYPOTHESIS_CATALOG, V2_VERSION, type HypothesisSpec } from "../config.js";
import { SAFETY_MARGIN_RETURN } from "../costs.js";
import { CANDIDATE_001_ID, CANDIDATE_001_STATUS } from "../pocket-001-postmortem.js";
import { buildPanel, filterRegime } from "../panel.js";
import {
  appendExperiment,
  freezeCandidate,
  nextCandidateId,
  nextExperimentId,
} from "../registry/store.js";
import {
  buildThresholdGrid,
  concentrationOk,
  featureImportance,
  metricsFromTrades,
  runRobustness,
  selectThresholdsOnDev,
  simulateZone,
  trainOnZone,
  sharpeLike,
} from "../validation/evaluate.js";
import { printLeakageAudit } from "../validation/leakage.js";
import type { ExperimentRecord, ExperimentStatus, HorizonId, ModelKind, TradeSim } from "../types.js";

export type HuntOptions = {
  maxCombos?: number;
  allowSealed?: boolean;
  hypothesisIds?: string[];
  includeRetired?: boolean;
};

function comboKey(h: HypothesisSpec, horizon: HorizonId, model: ModelKind): string {
  return `${h.id}|${horizon}|${model}`;
}

/** Sealed-side falsification required before any freeze. */
function sealedSurvivesFullAudit(trades: TradeSim[]): { ok: boolean; reason: string } {
  const m = metricsFromTrades(trades);
  if (m.n < EDGE_GATES.candidate.minN) return { ok: false, reason: `sealed n=${m.n} < ${EDGE_GATES.candidate.minN}` };
  if (m.netExpectancy <= 0) return { ok: false, reason: "sealed net <= 0" };
  if (m.ci95Low <= 0) return { ok: false, reason: "sealed CI crosses or below zero" };
  if (m.profitFactor < 1.1) return { ok: false, reason: `PF ${m.profitFactor.toFixed(2)} < 1.1` };
  const conc = concentrationOk(trades);
  if (!conc.ok) return { ok: false, reason: `concentration: ${conc.reason}` };

  const byPair = new Map<string, number>();
  for (const t of trades) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netReturn);
  let bestPair = "";
  let best = -Infinity;
  for (const [p, v] of byPair) {
    if (v > best) {
      best = v;
      bestPair = p;
    }
  }
  const dropPair = metricsFromTrades(trades.filter((t) => t.instrument !== bestPair));
  if (dropPair.netExpectancy <= 0) return { ok: false, reason: `drop best pair ${bestPair} kills edge` };

  const byMonth = new Map<string, number>();
  for (const t of trades) {
    const mo = t.closeTime.slice(0, 7);
    byMonth.set(mo, (byMonth.get(mo) ?? 0) + t.netReturn);
  }
  let bestMonth = "";
  let bestM = -Infinity;
  for (const [mo, v] of byMonth) {
    if (v > bestM) {
      bestM = v;
      bestMonth = mo;
    }
  }
  const dropMonth = metricsFromTrades(trades.filter((t) => t.closeTime.slice(0, 7) !== bestMonth));
  if (dropMonth.netExpectancy <= 0) return { ok: false, reason: `drop best month ${bestMonth} kills edge` };

  const sorted = [...trades].sort((a, b) => b.netReturn - a.netReturn);
  const dropTop5 = metricsFromTrades(sorted.slice(5));
  if (dropTop5.netExpectancy <= 0) return { ok: false, reason: "drop top-5 winners kills edge" };

  const cost50 = trades.map((t) => ({ ...t, netReturn: t.netReturn - 0.5 * Math.abs(t.spreadCost) }));
  const costM = metricsFromTrades(cost50);
  if (costM.netExpectancy <= 0) return { ok: false, reason: "sealed +~50% spread proxy kills edge" };

  return { ok: true, reason: "sealed full audit pass" };
}

export async function runHunt(options: HuntOptions = {}): Promise<void> {
  const maxCombos = options.maxCombos ?? 24;
  const allowSealed = options.allowSealed ?? true;
  const catalog = HYPOTHESIS_CATALOG.filter((h) => {
    if (!options.includeRetired && h.retired) return false;
    if (options.hypothesisIds) return options.hypothesisIds.includes(h.id);
    return true;
  });

  console.log(`\nGoldenXperience V2 Edge Hunt (${V2_VERSION})`);
  console.log(`Hypotheses in catalog: ${catalog.length} (${CANDIDATE_001_ID}=${CANDIDATE_001_STATUS})`);
  printLeakageAudit();

  const panelCache = new Map<string, Awaited<ReturnType<typeof buildPanel>>>();
  async function panelFor(h: HypothesisSpec) {
    const zones = h.zones;
    const key = `${(h.pairs ?? []).join(",")}|${h.timeframe ?? "H1"}|${h.featureFamilies.join("+")}|${h.horizons.join(",")}|stride${h.stride ?? 1}|z${zones?.sealedStart ?? "default"}`;
    let panel = panelCache.get(key);
    if (!panel) {
      console.log(`\nBuilding panel: ${key}`);
      panel = await buildPanel({
        pairs: h.pairs,
        timeframe: h.timeframe,
        families: h.featureFamilies,
        horizons: h.horizons,
        stride: h.stride ?? 1,
        zones,
      });
      console.log(`  samples=${panel.samples.length} pairs=${panel.pairs.join(",")} features=${panel.featureNames.length}`);
      panelCache.set(key, panel);
    }
    return panel;
  }

  let combos = 0;
  const leaderboard: Array<{ id: string; hypothesis: string; net: number; n: number; status: string }> = [];

  for (const h of catalog) {
    if (combos >= maxCombos) break;
    const panel = await panelFor(h);
    const samples = filterRegime(panel.samples, h.regimeFilter);
    const zones = panel.zones;
    const directionMode = h.directionMode ?? "both";

    for (const horizon of h.horizons) {
      if (combos >= maxCombos) break;
      for (const modelKind of h.modelKinds) {
        if (combos >= maxCombos) break;
        combos += 1;
        const experimentId = nextExperimentId();
        console.log(`\n── ${experimentId} ${comboKey(h, horizon, modelKind)}${directionMode !== "both" ? ` [${directionMode}]` : ""}`);
        console.log(`   ${h.hypothesis}`);

        let status: ExperimentStatus = "dev_reject";
        let reason = "";
        let sealedTouched = false;
        let candidateId: string | undefined;
        let robustness: ExperimentRecord["robustness"] = {};
        let importance: ExperimentRecord["featureImportance"] = [];
        let metrics = metricsFromTrades([]);
        let thresholds = buildThresholdGrid()[0]!;

        try {
          const model = trainOnZone({
            samples,
            zones,
            featureNames: panel.featureNames,
            horizon,
            kind: modelKind,
          });
          importance = featureImportance(model).slice(0, 15);

          const selected = selectThresholdsOnDev({
            samples,
            zones,
            model,
            horizon,
            grid: buildThresholdGrid(),
            directionMode,
          });
          thresholds = selected.thresholds;
          const devTrades = selected.trades;
          const devM = metricsFromTrades(devTrades);
          metrics = devM;
          const conc = concentrationOk(devTrades);

          console.log(
            `   DEV n=${devM.n} net=${devM.netExpectancy.toExponential(3)} CI=[${devM.ci95Low.toExponential(3)}, ${devM.ci95High.toExponential(3)}] wr=${(devM.winRate * 100).toFixed(1)}%`,
          );

          if (devM.n < EDGE_GATES.discovery.minN || devM.netExpectancy <= EDGE_GATES.discovery.minNetExpectancy) {
            status = "dev_reject";
            reason = `DEV failed discovery (n=${devM.n}, net=${devM.netExpectancy.toExponential(3)})`;
          } else if (!conc.ok) {
            status = "dev_reject";
            reason = `DEV concentration: ${conc.reason}`;
          } else if (devM.ci95Low <= 0 && devM.n < 200) {
            status = "inconclusive";
            reason = `DEV positive but underpowered (n=${devM.n}, ciLow=${devM.ci95Low.toExponential(3)})`;
          } else {
            robustness = runRobustness({
              samples,
              zones,
              model,
              horizon,
              thresholds,
              directionMode,
            });
            const robustFail = Object.entries(robustness).filter(([k, v]) => k !== "spread_+50pct" && !v.pass);
            if (robustFail.length >= 2) {
              status = "robustness_reject";
              reason = `DEV robustness failures: ${robustFail.map(([k]) => k).join(", ")}`;
            } else if (!allowSealed) {
              status = "inconclusive";
              reason = "DEV+robustness interest; sealed deferred";
            } else {
              sealedTouched = true;
              const sealedTrades = simulateZone({
                samples,
                zones,
                zone: "sealed",
                model,
                horizon,
                thresholds,
                directionMode,
              });
              const sealedM = metricsFromTrades(sealedTrades);
              metrics = sealedM;
              console.log(
                `   SEALED n=${sealedM.n} net=${sealedM.netExpectancy.toExponential(3)} CI=[${sealedM.ci95Low.toExponential(3)}, ${sealedM.ci95High.toExponential(3)}]`,
              );

              const audit = sealedSurvivesFullAudit(sealedTrades);
              robustness = {
                ...robustness,
                sealed_full_audit: { pass: audit.ok, note: audit.reason, netExpectancy: sealedM.netExpectancy },
              };

              if (audit.ok) {
                status = "sealed_pass";
                reason = `ROBUST sealed pass: ${audit.reason}`;
                candidateId = nextCandidateId();
                freezeCandidate(candidateId, {
                  candidateId,
                  mode: "SHADOW_ONLY",
                  grade: "strong_candidate",
                  hypothesis: h.hypothesis,
                  hypothesisId: h.id,
                  modelKind,
                  horizon,
                  directionMode,
                  featureFamilies: h.featureFamilies,
                  featureNames: panel.featureNames,
                  thresholds,
                  zones,
                  sealedMetrics: sealedM,
                  importance,
                  safetyMargin: SAFETY_MARGIN_RETURN,
                  frozenAt: new Date().toISOString(),
                  note: "Survived sealed full robustness audit. Forward shadow only.",
                });
                console.log(`   ★ Frozen ${candidateId} SHADOW_ONLY (full audit PASS)`);
              } else {
                status = "sealed_fail";
                reason =
                  sealedM.netExpectancy > 0 && sealedM.n >= EDGE_GATES.candidate.minN
                    ? `Sealed positive but FULL AUDIT FAIL: ${audit.reason}`
                    : `SEALED fail — ${audit.reason}`;
                console.log(`   ✗ ${reason}`);
              }
            }
          }
        } catch (err) {
          status = "error";
          reason = err instanceof Error ? err.message : String(err);
          console.log(`   ERROR ${reason}`);
        }

        const record: ExperimentRecord = {
          experimentId,
          timestamp: new Date().toISOString(),
          hypothesis: h.hypothesis,
          modelType: modelKind,
          featureFamilies: h.featureFamilies,
          featureNames: panel.featureNames,
          pairUniverse: panel.pairs,
          timeframe: panel.timeframe,
          horizon,
          trainDates: { start: zones.trainStart, end: zones.trainEnd },
          validationDates: { start: zones.devStart, end: zones.devEnd },
          sealedDates: { start: zones.sealedStart, end: zones.sealedEnd },
          thresholds: { ...thresholds },
          hyperparameters: { modelKind, directionMode },
          n: metrics.n,
          winRate: metrics.winRate,
          grossExpectancy: metrics.grossExpectancy,
          netExpectancy: metrics.netExpectancy,
          ci95Low: metrics.ci95Low,
          ci95High: metrics.ci95High,
          sharpeLike: sharpeLike([]),
          maxDrawdown: metrics.maxDrawdown,
          spreadPaid: metrics.avgSpreadCost,
          byPair: metrics.byPair,
          byMonth: metrics.byMonth,
          robustness,
          featureImportance: importance,
          status,
          reason,
          sealedTouched,
          candidateId,
        };
        appendExperiment(record);
        leaderboard.push({
          id: experimentId,
          hypothesis: `${h.id}/${horizon}/${modelKind}`,
          net: metrics.netExpectancy,
          n: metrics.n,
          status,
        });
        console.log(`   → ${status}: ${reason}`);
      }
    }
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`GoldenXperience V2 Edge Hunt`);
  console.log(`Experiments tested this run: ${combos}`);
  console.log(`\nLeaderboard (this run):`);
  const sorted = [...leaderboard].sort((a, b) => b.net - a.net);
  for (const [i, row] of sorted.slice(0, 12).entries()) {
    console.log(
      `${i + 1}. ${row.id} ${row.hypothesis} n=${row.n} net=${row.net.toExponential(3)} [${row.status}]`,
    );
  }
}
