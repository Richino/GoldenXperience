import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observerReplayFixture } from "./observer-replay-fixture.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(root, "outputs", "observer-phase-7-synthetic");
await mkdir(directory, { recursive: true });
const fixture = observerReplayFixture(), plan = path.join(directory, "frozen-plan.json"), recording = path.join(directory, "quotes.ndjson");
await writeFile(plan, JSON.stringify(fixture.plan, null, 2) + "\n");
await writeFile(recording, fixture.records.map(row => JSON.stringify(row)).join("\n") + "\n");
async function run(name: string, until?: string) {
  const output = path.join(directory, `${name}.json`);
  const args = ["--import", "tsx", fileURLToPath(new URL("./market-recording.ts", import.meta.url)), "evaluate", recording, `--plan=${plan}`, `--output=${output}`, ...(until ? [`--until=${until}`] : [])];
  const child = spawn(process.execPath, args, { cwd: path.join(root, "api-server"), stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Replay CLI exited ${code}`))); });
  const result = JSON.parse(await readFile(output, "utf8"));
  return { output, result };
}
const full = await run("full-replay"), cutoff = await run("cutoff-replay", fixture.iso(300_750));
assert.equal(full.result.plan.triggeredAt, fixture.iso(301_000));
assert.equal(full.result.plan.outcome.kind, "target_observed");
assert.equal(cutoff.result.plan.triggeredAt, null);
console.log(JSON.stringify({ syntheticFixture: true, mechanismCheckOnly: true, fullReport: full.output, cutoffReport: cutoff.output, delayedConfirmationPassed: true, futureCutoffPassed: true }, null, 2));
