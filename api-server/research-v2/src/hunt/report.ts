import { readExperiments } from "../registry/store.js";

export function printFullReport(): void {
  const rows = readExperiments();
  console.log(`\nGoldenXperience V2 Edge Hunt\n`);
  console.log(`Experiments tested (all time): ${rows.length}`);

  const sealedPass = rows.filter((r) => r.status === "sealed_pass");
  const sealedFail = rows.filter((r) => r.status === "sealed_fail");
  const devReject = rows.filter((r) => r.status === "dev_reject");
  const robustReject = rows.filter((r) => r.status === "robustness_reject");

  console.log(`  sealed_pass: ${sealedPass.length}`);
  console.log(`  sealed_fail: ${sealedFail.length}`);
  console.log(`  robustness_reject: ${robustReject.length}`);
  console.log(`  dev_reject: ${devReject.length}`);

  const topDev = [...rows]
    .filter((r) => r.n >= 40)
    .sort((a, b) => b.netExpectancy - a.netExpectancy)
    .slice(0, 10);

  console.log(`\nTop recorded candidates:`);
  for (const [i, r] of topDev.entries()) {
    console.log(`\n${i + 1}.`);
    console.log(`Model: ${r.modelType}`);
    console.log(`Hypothesis: ${r.hypothesis}`);
    console.log(`Pairs: ${r.pairUniverse.slice(0, 6).join(" / ")}${r.pairUniverse.length > 6 ? " ..." : ""}`);
    console.log(`Horizon: ${r.horizon}`);
    console.log(`n: ${r.n}`);
    console.log(`Net expectancy: ${fmt(r.netExpectancy)}`);
    console.log(`95% CI: ${fmt(r.ci95Low)} → ${fmt(r.ci95High)}`);
    console.log(`Status: ${r.status.toUpperCase()}${r.sealedTouched ? " (sealed touched)" : ""}`);
    console.log(`Reason: ${r.reason}`);
  }

  if (sealedPass.length) {
    console.log(`\nSEALED HOLDOUT PASSES:`);
    for (const r of sealedPass) {
      console.log(`\nPASS ${r.candidateId ?? r.experimentId}`);
      console.log(`n: ${r.n}`);
      console.log(`expectancy: ${fmt(r.netExpectancy)}`);
      console.log(`95% CI: ${fmt(r.ci95Low)} → ${fmt(r.ci95High)}`);
      console.log(`win rate: ${(r.winRate * 100).toFixed(1)}%`);
      console.log(`max drawdown: ${fmt(r.maxDrawdown)}`);
      console.log(`spread cost: ${fmt(r.spreadPaid)}`);
    }
  } else {
    console.log(`\nNo sealed_pass candidates yet.`);
  }
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const ax = Math.abs(x);
  if (ax !== 0 && ax < 1e-3) return x.toExponential(3);
  return (x >= 0 ? "+" : "") + x.toFixed(6);
}
