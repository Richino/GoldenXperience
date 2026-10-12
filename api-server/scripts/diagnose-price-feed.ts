import WebSocket from "ws";
import { mkdir, writeFile } from "node:fs/promises";
const ws = new WebSocket("ws://localhost:8787");
const startedAt = new Date().toISOString();
const ticks: Array<{ receivedAt: string; brokerAt: string; lagMs: number }> = [];
const statuses: Array<{ at: string; state: string; source: string }> = [];
let heartbeats = 0;
ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", instruments: ["EUR_USD"] })));
ws.on("message", raw => {
  const value = JSON.parse(raw.toString()), received = Date.now();
  if (value.type === "heartbeat") heartbeats++;
  if (value.type === "status") statuses.push({ at: new Date(received).toISOString(), state: value.state, source: value.source });
  if (value.type === "price" && value.instrument === "EUR_USD") ticks.push({ receivedAt: new Date(received).toISOString(), brokerAt: value.time, lagMs: received - Date.parse(value.time) });
});
ws.on("error", error => console.error(error.message));
await new Promise(resolve => setTimeout(resolve, 60_000));
ws.close();
const gaps = ticks.slice(1).map((tick, i) => Date.parse(tick.receivedAt) - Date.parse(ticks[i].receivedAt));
const report = { source: "existing local API WebSocket", startedAt, endedAt: new Date().toISOString(), quotes: ticks.length, heartbeats, statuses,
  gapsOver5Seconds: gaps.filter(n => n > 5000).length, maxGapMs: gaps.length ? Math.max(...gaps) : null,
  maxBrokerLagMs: ticks.length ? Math.max(...ticks.map(t => t.lagMs)) : null, gapsMs: gaps, ticks };
const directory = new URL("../../outputs/price-feed-diagnostic/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("app-feed.json", directory), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, ticks: undefined, gapsMs: undefined }, null, 2));
