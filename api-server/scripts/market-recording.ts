import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { OandaPricingStream } from "../src/oanda-stream.js";
import { MarketRecorder, auditMarketRecording, replayMarketRecording } from "../src/market-recording.js";
import { startRecordingContext } from "../src/market-recording-context.js";
import { MarketMovementEngine } from "../src/market-movement.js";
import { MarketPatternEngine, type PatternEvent } from "../src/market-patterns.js";
import { MarketStateEngine } from "../src/market-state.js";
import { PATTERN_RULES_VERSION } from "../src/market-pattern-definitions.js";
import { isKnownInstrument } from "../../frontend/src/lib/instruments/catalog.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
loadDotenv({ path: path.join(root, "frontend/.env.local"), quiet: true });
loadDotenv({ path: path.join(root, ".env"), quiet: true });
loadDotenv({ path: path.join(root, "api-server/.env"), quiet: true });

async function main() {
  const [command, file, ...args] = process.argv.slice(2);
  if (command === "audit" && file) { console.log(JSON.stringify(await auditMarketRecording(path.resolve(root, file)), null, 2)); return; }
  if (command === "observer" && file) {
    const instrument = (args.find(x => x.startsWith("--instrument="))?.slice(13) ?? "EUR_USD").toUpperCase();
    const until = args.find(x => x.startsWith("--until="))?.slice(8);
    const patterns = new MarketPatternEngine([instrument]), observer = new MarketStateEngine(patterns);
    let asOf: string | null = null, lastRevision = 0;
    for await (const record of replayMarketRecording(path.resolve(root, file), { until })) {
      if (record.kind === "session" && (!Array.isArray(record.data.instruments) || !record.data.instruments.includes(instrument))) throw new Error("Requested observer instrument was not recorded.");
      patterns.consume(record); asOf = record.receivedAt;
      if (record.kind === "calendar") observer.calendarContext(record.data, asOf);
      if (record.kind === "context-error") observer.contextError(record.data);
      const read = observer.update(instrument, asOf);
      if (args.includes("--events") && read.revision !== lastRevision) {
        if (!process.stdout.write(JSON.stringify(read) + "\n")) await once(process.stdout, "drain");
        lastRevision = read.revision;
      }
    }
    if (!asOf) throw new Error("No observations available.");
    if (!args.includes("--events")) console.log(JSON.stringify(observer.update(instrument, until ?? asOf), null, 2));
    return;
  }
  if ((command === "movement" || command === "patterns") && file) {
    const until = args.find(x => x.startsWith("--until="))?.slice(8);
    const instrument = (args.find(x => x.startsWith("--instrument="))?.slice(13) ?? "EUR_USD").toUpperCase();
    const eventOutput = command === "patterns" && args.includes("--events");
    const pendingEvents: PatternEvent[] = [];
    const movement = command === "patterns" ? new MarketPatternEngine([instrument], undefined, eventOutput ? event => pendingEvents.push(event) : undefined) : new MarketMovementEngine([instrument]);
    let asOf: string | null = null;
    let lastQuoteSnapshot: ReturnType<typeof movement.snapshot> | null = null;
    // Do not filter out other pairs' rows: their sequence numbers preserve log continuity.
    for await (const record of replayMarketRecording(path.resolve(root, file), { until })) {
      if (record.kind === "session" && (!Array.isArray(record.data.instruments) || !record.data.instruments.includes(instrument))) throw new Error("Requested movement instrument was not recorded in this session.");
      movement.consume(record); asOf = record.receivedAt;
      if (eventOutput) {
        for (const event of pendingEvents) if (!process.stdout.write(JSON.stringify({ rulesVersion: PATTERN_RULES_VERSION, ...event }) + "\n")) await once(process.stdout, "drain");
        pendingEvents.length = 0;
      } else if (record.kind === "quote" && record.data.instrument === instrument) lastQuoteSnapshot = movement.snapshot(instrument, asOf);
    }
    if (!asOf) throw new Error("No observations available at the requested cutoff.");
    if (eventOutput) return;
    console.log(JSON.stringify({ snapshot: movement.snapshot(instrument, until ?? asOf), lastQuoteSnapshot }, null, 2));
    return;
  }
  if (command === "replay" && file) {
    const until = args.find(x => x.startsWith("--until="))?.slice(8);
    const instrument = args.find(x => x.startsWith("--instrument="))?.slice(13);
    for await (const record of replayMarketRecording(path.resolve(root, file), { until, instrument })) {
      if (!process.stdout.write(JSON.stringify(record) + "\n")) await once(process.stdout, "drain");
    }
    return;
  }
  if (command !== "capture") throw new Error("Usage: market-recording.ts capture [PAIR,PAIR] [--seconds=N] | audit FILE | replay FILE | movement FILE | patterns FILE [--until=ISO] [--instrument=PAIR]");
  if ((process.env.OANDA_ENVIRONMENT ?? "practice").toLowerCase() !== "practice") throw new Error("Recording is practice-only.");
  const instruments = (file && !file.startsWith("--") ? file : "EUR_USD").split(",").map(value => value.trim().toUpperCase());
  if (!instruments.every(isKnownInstrument)) throw new Error("Unknown recording instrument.");
  const accountId = process.env.OANDA_ACCOUNT_ID ?? null;
  const apiKey = process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? null;
  if (!accountId || !apiKey) throw new Error("OANDA practice credentials are required; mock quotes cannot be recorded.");
  const durationArg = [file, ...args].find(x => x?.startsWith("--seconds="));
  const seconds = durationArg ? Number(durationArg.slice(10)) : null;
  if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error("Invalid capture duration.");
  const recorder = new MarketRecorder({ directory: process.env.MARKET_RECORDING_DIR ?? path.join(root, "data/market-recordings"), instruments, environment: "practice" });
  const movement = new MarketMovementEngine(instruments);
  const patterns = new MarketPatternEngine(instruments, movement);
  const stream = new OandaPricingStream({ accountId, apiKey, environment: "practice", streamBaseUrl: "https://stream-fxpractice.oanda.com", port: 0, instruments, isConfigured: true }, {
    onIssue: (reason, receivedAt) => { recorder.record("stream-error", { reason }, receivedAt); patterns.breakContinuity("stream_message_error", receivedAt); },
    onObservation: (raw, receivedAt) => { recorder.quote(raw, receivedAt); patterns.observe(raw, receivedAt); },
    onPrice: () => {},
    onHeartbeat: (value, receivedAt) => recorder.record("heartbeat", { brokerTime: value.time }, receivedAt),
    onStatus: value => { const receivedAt = new Date().toISOString(); recorder.record("connection", { state: value.state, source: value.source }, receivedAt); patterns.setConnection(value.state, value.source, receivedAt); },
  });
  const stopContext = startRecordingContext(recorder, instruments, undefined, (kind, data, receivedAt) => {
    if (kind === "candles") patterns.context(data, receivedAt);
    if (kind === "context-error") patterns.contextError(data);
  });
  console.log(`Practice observation recorder: ${recorder.file}`);
  console.log("No orders or trading schedulers are started.");
  let stopping = false;
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    stream.stop(); stopContext();
    clearInterval(health);
    if (duration) clearTimeout(duration);
    await recorder.close();
    console.log(JSON.stringify(recorder.status(), null, 2));
    process.exit(recorder.status().failure ? 1 : 0);
  };
  const health = setInterval(() => {
    console.log(JSON.stringify(recorder.status()));
    console.log(JSON.stringify({ movement: instruments.map(instrument => movement.snapshot(instrument)) }));
    console.log(JSON.stringify({ patterns: instruments.map(instrument => patterns.snapshot(instrument)) }));
    if (recorder.status().failure) void finish();
  }, 30_000);
  const duration = seconds ? setTimeout(() => void finish(), seconds * 1000) : null;
  process.on("SIGINT", () => void finish());
  process.on("SIGTERM", () => void finish());
  stream.start();
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
