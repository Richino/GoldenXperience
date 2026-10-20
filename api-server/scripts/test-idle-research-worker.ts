import assert from "node:assert/strict";
import { startIdleResearchWorker } from "../src/idle-research-worker.js";

type Task = { run: () => void; delay: number; cancelled: boolean };
const tasks: Task[] = [];
const schedule = (run: () => void, delay: number) => {
  const task = { run, delay, cancelled: false }; tasks.push(task);
  return () => { task.cancelled = true; };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
let result = { processed: false };
let calls = 0;
let pending: Promise<{ processed: boolean }> | null = null;
const stop = startIdleResearchWorker(async () => { calls++; return pending ?? result; }, error => { throw error; }, schedule);
await flush();
assert.equal(calls, 1, "checks the queue immediately on startup");
assert.equal(tasks[0].delay, 30000, "an empty queue backs off to 30 seconds");

result = { processed: true };
tasks[0].run(); await flush();
assert.equal(calls, 2);
assert.equal(tasks[1].delay, 1000, "active work resumes the one-second cadence");

let finish!: (value: { processed: boolean }) => void;
pending = new Promise(resolve => { finish = resolve; });
tasks[1].run(); await flush();
assert.equal(calls, 3);
assert.equal(tasks.length, 2, "does not schedule another tick while work is in flight");
stop(); finish({ processed: true }); await flush();
assert.equal(tasks.length, 2, "shutdown during a job cannot rearm polling");

const errors: unknown[] = [];
const stopError = startIdleResearchWorker(async () => { throw new Error("temporary database failure"); }, error => errors.push(error), schedule);
await flush();
assert.equal(errors.length, 1);
assert.equal(tasks[2].delay, 30000, "errors also back off instead of hammering the database");
stopError();
assert.equal(tasks[2].cancelled, true, "shutdown cancels a pending timeout");
tasks[2].run(); await flush();
assert.equal(errors.length, 1, "an already dispatched callback does nothing after shutdown");
console.log("Idle research worker checks passed: idle/active cadence, no overlapping jobs, error backoff and shutdown.");
