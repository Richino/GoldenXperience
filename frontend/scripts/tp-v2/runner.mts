// Worker-pool grid runner. Every evaluated config is recorded with its overall
// summary and per-year sums, so walk-forward selection can later range over
// everything that was ever tried.
import fs from "node:fs";
import os from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Config } from "./engine.mts";

export type YearSums = Record<number, { n: number; sum: number; sumsq: number; wins: number; gw: number; gl: number }>;
export type Result = { id: string; cfg: Config; s: import("./lib.mts").Summary; years: YearSums };

export const cfgId = (c: Config) => JSON.stringify(c);

export async function runGrid(configs: Config[], opts: { dataDir: string; start: number; end: number; newsFile?: string; workers?: number; withTrades?: boolean }): Promise<Array<Result & { trades?: unknown[] }>> {
  const n = Math.min(opts.workers ?? Math.max(1, os.cpus().length - 4), configs.length);
  const queue = configs.map((c, i) => ({ i, c }));
  const results: Array<Result & { trades?: unknown[] }> = new Array(configs.length);
  let done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, () => new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: opts, execArgv: ["--import", "tsx"] });
    const next = () => {
      const job = queue.shift();
      if (!job) { void w.terminate(); resolve(); return; }
      w.postMessage(job);
    };
    w.on("message", (m: { i: number; r: Result & { trades?: unknown[] } }) => {
      results[m.i] = m.r;
      done += 1;
      if (done % 50 === 0 || done === configs.length) process.stderr.write(`  ${done}/${configs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
      next();
    });
    w.on("error", reject);
    w.once("online", next);
  })));
  return results;
}

if (!isMainThread) {
  const { loadData, simulate } = await import("./engine.mts");
  const { summarize } = await import("./lib.mts");
  const o = workerData as { dataDir: string; start: number; end: number; newsFile?: string; withTrades?: boolean };
  const d = loadData(o.dataDir, o.start, o.end, o.newsFile);
  parentPort!.on("message", ({ i, c }: { i: number; c: Config }) => {
    const trades = simulate(d, c);
    const years: YearSums = {};
    for (const x of trades) {
      const y = (years[x.year] ??= { n: 0, sum: 0, sumsq: 0, wins: 0, gw: 0, gl: 0 });
      y.n += 1; y.sum += x.r; y.sumsq += x.r * x.r;
      if (x.r > 0) { y.wins += 1; y.gw += x.r; } else y.gl -= x.r;
    }
    const r: Result & { trades?: unknown[] } = { id: cfgId(c), cfg: c, s: summarize(trades, (o.end - o.start) / (365.25 * 86_400_000)), years };
    if (o.withTrades) r.trades = trades;
    parentPort!.postMessage({ i, r });
  });
}

/** Append results to the registry of everything evaluated (dedup by id). */
export function record(file: string, results: Result[]) {
  const all: Record<string, Result> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  for (const r of results) all[r.id] = { id: r.id, cfg: r.cfg, s: r.s, years: r.years };
  fs.writeFileSync(file, JSON.stringify(all));
  return Object.keys(all).length;
}
