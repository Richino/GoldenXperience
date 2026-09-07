/** Controlled exit-geometry replay only: frozen entries/directions from EURUSD_ELITE_DIRECTION_V1. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.join(ROOT, "api-server", "research-v2", "EURUSD_ELITE_DIRECTION_V1");
const PIP = 0.0001, ENTRY_SLIP = 0.1 * PIP, EXIT_SLIP = 0.1 * PIP, HOLD_BARS = 12;
type Raw = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Signal = { time: string; direction: "LONG" | "SHORT"; unit_pips: string };
type Result = Signal & { geometry: string; entry: number; stop: number; target: number; result_r: number; outcome: string; exit_time: string; hold_minutes: number };

function parseCsv(text: string) {
  const parse = (line: string) => [...line.matchAll(/"((?:"")*[^"]*)"(?:,|$)/g)].map((m) => m[1]!.replaceAll('""', '"'));
  const [head, ...body] = text.trim().split(/\r?\n/).map(parse); return body.map((cells) => Object.fromEntries(head.map((key, index) => [key, cells[index] ?? ""])));
}
function csv(rows: Record<string, unknown>[]) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]; const q = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [keys.map(q).join(","), ...rows.map((row) => keys.map((key) => q(row[key])).join(","))].join("\n") + "\n";
}
function mean(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function metrics(results: Result[]) {
  const r = results.map((x) => x.result_r), wins = r.filter((x) => x > 0), losses = r.filter((x) => x < 0); let equity = 0, peak = 0, maxDrawdown = 0;
  for (const value of r) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  return { trades: r.length, win_rate: wins.length / Math.max(1, r.length), expectancy_r: mean(r), total_r: equity, profit_factor: wins.reduce((a, b) => a + b, 0) / Math.max(1e-9, -losses.reduce((a, b) => a + b, 0)), max_drawdown_r: maxDrawdown, target_rate: results.filter((x) => x.outcome === "TARGET").length / Math.max(1, r.length), stop_rate: results.filter((x) => x.outcome === "STOP").length / Math.max(1, r.length), ambiguous: results.filter((x) => x.outcome === "AMBIGUOUS_STOP").length, time_exit: results.filter((x) => x.outcome === "TIME_EXIT").length };
}
function replay(signal: Signal, bars: Raw[], index: number, targetR: number, stopR: number): Result {
  const direction = signal.direction === "LONG" ? 1 : -1; const unit = Number(signal.unit_pips) * PIP; const entryBar = bars[index + 1]!;
  const entry = direction === 1 ? entryBar.askOpen + ENTRY_SLIP : entryBar.bidOpen - ENTRY_SLIP;
  const stop = direction === 1 ? entry - stopR * unit : entry + stopR * unit; const target = direction === 1 ? entry + targetR * unit : entry - targetR * unit;
  for (let j = index + 1; j <= Math.min(index + HOLD_BARS, bars.length - 1); j += 1) {
    const bar = bars[j]!; const high = direction === 1 ? bar.bidHigh : bar.askHigh; const low = direction === 1 ? bar.bidLow : bar.askLow;
    const hitTarget = direction === 1 ? high >= target : low <= target; const hitStop = direction === 1 ? low <= stop : high >= stop;
    const hold = (Date.parse(bar.closeTime) - Date.parse(signal.time)) / 60_000;
    if (hitTarget && hitStop) return { ...signal, geometry: `+${targetR}R/-${stopR}R`, entry, stop, target, result_r: -stopR - EXIT_SLIP / unit, outcome: "AMBIGUOUS_STOP", exit_time: bar.closeTime, hold_minutes: hold };
    if (hitStop) return { ...signal, geometry: `+${targetR}R/-${stopR}R`, entry, stop, target, result_r: -stopR - EXIT_SLIP / unit, outcome: "STOP", exit_time: bar.closeTime, hold_minutes: hold };
    if (hitTarget) return { ...signal, geometry: `+${targetR}R/-${stopR}R`, entry, stop, target, result_r: targetR - EXIT_SLIP / unit, outcome: "TARGET", exit_time: bar.closeTime, hold_minutes: hold };
  }
  const bar = bars[Math.min(index + HOLD_BARS, bars.length - 1)]!; const exit = direction === 1 ? bar.bidClose - EXIT_SLIP : bar.askClose + EXIT_SLIP;
  return { ...signal, geometry: `+${targetR}R/-${stopR}R`, entry, stop, target, result_r: Math.max(-stopR - EXIT_SLIP / unit, Math.min(targetR - EXIT_SLIP / unit, direction * (exit - entry) / unit)), outcome: "TIME_EXIT", exit_time: bar.closeTime, hold_minutes: (Date.parse(bar.closeTime) - Date.parse(signal.time)) / 60_000 };
}

const signals = parseCsv(readFileSync(path.join(OUT, "LOSS_DIAGNOSIS.csv"), "utf8")) as Signal[];
const bars = JSON.parse(readFileSync(path.join(ROOT, "backtest-legacy-expanded", "candles", "EUR_USD_M15.json"), "utf8")).bars as Raw[];
const indexByTime = new Map(bars.map((bar, index) => [bar.closeTime, index]));
const control = signals.map((signal) => replay(signal, bars, indexByTime.get(signal.time)!, 1, 0.5));
const oneToOne = signals.map((signal) => replay(signal, bars, indexByTime.get(signal.time)!, 1, 1));
const halfToOne = signals.map((signal) => replay(signal, bars, indexByTime.get(signal.time)!, 0.5, 1));
const controlMetrics = metrics(control), oneToOneMetrics = metrics(oneToOne), halfToOneMetrics = metrics(halfToOne);
const unchanged = control.every((result, index) => Math.abs(result.result_r - Number((signals[index] as unknown as Record<string, string>).result_r ?? result.result_r)) < 1e-9);
const byOutcome = (rows: Result[]) => Object.fromEntries(["TARGET", "STOP", "AMBIGUOUS_STOP", "TIME_EXIT"].map((kind) => [kind, rows.filter((row) => row.outcome === kind).length]));
const summary = [
  { geometry: "+1R/-0.5R control", ...controlMetrics, outcomes: JSON.stringify(byOutcome(control)) },
  { geometry: "+1R/-1R matched replay", ...oneToOneMetrics, outcomes: JSON.stringify(byOutcome(oneToOne)) },
  { geometry: "+0.5R/-1R matched replay", ...halfToOneMetrics, outcomes: JSON.stringify(byOutcome(halfToOne)) },
];
const report = `# Controlled +1R/-1R replay\n\nThis is a **matched exit-geometry test**, not a retrained model: it replays the same ${signals.length} frozen EURUSD_ELITE_DIRECTION_V1 entries and directions from 2025-11-01 through 2026-08-01. Bid/ask execution, 0.1-pip entry/exit slippage, three-hour maximum hold, and conservative same-candle TP/SL handling are unchanged.\n\n| Geometry | Trades | Win rate | Avg R | Total R | PF | Max DD | Target rate | Stops | Time exits | Ambiguous |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| +1R/-0.5R control | ${controlMetrics.trades} | ${(100 * controlMetrics.win_rate).toFixed(1)}% | ${controlMetrics.expectancy_r.toFixed(4)} | ${controlMetrics.total_r.toFixed(2)} | ${controlMetrics.profit_factor.toFixed(3)} | ${controlMetrics.max_drawdown_r.toFixed(2)} | ${(100 * controlMetrics.target_rate).toFixed(1)}% | ${byOutcome(control).STOP} | ${byOutcome(control).TIME_EXIT} | ${controlMetrics.ambiguous} |\n| +1R/-1R | ${oneToOneMetrics.trades} | ${(100 * oneToOneMetrics.win_rate).toFixed(1)}% | ${oneToOneMetrics.expectancy_r.toFixed(4)} | ${oneToOneMetrics.total_r.toFixed(2)} | ${oneToOneMetrics.profit_factor.toFixed(3)} | ${oneToOneMetrics.max_drawdown_r.toFixed(2)} | ${(100 * oneToOneMetrics.target_rate).toFixed(1)}% | ${byOutcome(oneToOne).STOP} | ${byOutcome(oneToOne).TIME_EXIT} | ${oneToOneMetrics.ambiguous} |\n\nControl reproduction check: **${unchanged ? "PASS" : "FAIL"}**. Results are independent per frozen entry; they do not alter selection, retrain the model, or change the live/paper engine.\n`;
writeFileSync(path.join(OUT, "GEOMETRY_1_TO_1_REPLAY.csv"), csv(oneToOne));
writeFileSync(path.join(OUT, "GEOMETRY_1_TO_1_REPLAY.md"), report);
const halfReport = `# Controlled +0.5R/-1R replay\n\nThis is a **matched exit-geometry test**, not a retrained model: it replays the same ${signals.length} frozen EURUSD_ELITE_DIRECTION_V1 entries and directions from 2025-11-01 through 2026-08-01. Bid/ask execution, 0.1-pip entry/exit slippage, three-hour maximum hold, and conservative same-candle TP/SL handling are unchanged.\n\n| Geometry | Trades | Win rate | Avg R | Total R | PF | Max DD | Target rate | Stops | Time exits | Ambiguous |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| +1R/-0.5R control | ${controlMetrics.trades} | ${(100 * controlMetrics.win_rate).toFixed(1)}% | ${controlMetrics.expectancy_r.toFixed(4)} | ${controlMetrics.total_r.toFixed(2)} | ${controlMetrics.profit_factor.toFixed(3)} | ${controlMetrics.max_drawdown_r.toFixed(2)} | ${(100 * controlMetrics.target_rate).toFixed(1)}% | ${byOutcome(control).STOP} | ${byOutcome(control).TIME_EXIT} | ${controlMetrics.ambiguous} |\n| +0.5R/-1R | ${halfToOneMetrics.trades} | ${(100 * halfToOneMetrics.win_rate).toFixed(1)}% | ${halfToOneMetrics.expectancy_r.toFixed(4)} | ${halfToOneMetrics.total_r.toFixed(2)} | ${halfToOneMetrics.profit_factor.toFixed(3)} | ${halfToOneMetrics.max_drawdown_r.toFixed(2)} | ${(100 * halfToOneMetrics.target_rate).toFixed(1)}% | ${byOutcome(halfToOne).STOP} | ${byOutcome(halfToOne).TIME_EXIT} | ${halfToOneMetrics.ambiguous} |\n\nControl reproduction check: **${unchanged ? "PASS" : "FAIL"}**. Results are independent per frozen entry; they do not alter selection, retrain the model, or change the live/paper engine.\n`;
writeFileSync(path.join(OUT, "GEOMETRY_0_5_TO_1_REPLAY.csv"), csv(halfToOne));
writeFileSync(path.join(OUT, "GEOMETRY_0_5_TO_1_REPLAY.md"), halfReport);
console.log(JSON.stringify({ control: controlMetrics, oneToOne: oneToOneMetrics, halfToOne: halfToOneMetrics, controlReproduction: unchanged, outcomes: byOutcome(halfToOne) }, null, 2));
