import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { getResearchCandles, oandaEnvironment } from "../../frontend/src/lib/oanda/client.js";
import { replayNewsExits, type ReplayQuote } from "../src/news-straddle/replay.js";
config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
if (oandaEnvironment() !== "practice") throw new Error("Historical replay requires practice configuration.");
const eventFile = process.env.NEWS_REPLAY_EVENTS ?? "research-v2/eurusd-ff-high-impact-aug2025-jul2026/events.json";
const raw = JSON.parse(await readFile(eventFile, "utf8")) as { source: string; events: Array<{ releaseTimeUtc: string; eventName: string; currency: string }> };
const limit = Number(process.env.NEWS_REPLAY_LIMIT ?? 8);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("NEWS_REPLAY_LIMIT must be 1–100.");
const unique = new Map<string, typeof raw.events[number]>();
for (const e of raw.events) if (Number.isFinite(Date.parse(e.releaseTimeUtc)) && !/speaks|speech|tentative|all.day|meeting day/i.test(e.eventName)) unique.set(e.releaseTimeUtc, e);
const events = [...unique.values()].sort((a, b) => Date.parse(b.releaseTimeUtc) - Date.parse(a.releaseTimeUtc)).slice(0, limit);
const assumptions = { pip: 0.0001, offsetPips: 10, stopPips: 15, maxSpreadPips: 3, boundPips: 2, adverseSlippagePips: 0.5, activationPips: 10, trailPips: 7, activationLatencyMs: 250, windowMs: 60_000 };
const output = path.resolve("../outputs/news-straddle-v3-replay"); await mkdir(output, { recursive: true });
const results: Array<{ time: string; title: string; path: string; dataPoints: number; result: ReturnType<typeof replayNewsExits> }> = [];
for (const event of events) {
  const t = Date.parse(event.releaseTimeUtc), cache = path.join(output, `${event.releaseTimeUtc.slice(0, 19).replaceAll(":", "-")}-S5.json`);
  let bars: Awaited<ReturnType<typeof getResearchCandles>>;
  try { bars = JSON.parse(await readFile(cache, "utf8")); }
  catch { bars = await getResearchCandles("EUR_USD", "S5", 400, { to: new Date(t + 30 * 60_000).toISOString() }); await writeFile(cache, JSON.stringify(bars)); }
  const anchorBar = bars.filter(b => b.complete && Date.parse(b.time) <= t - 5000).at(-1);
  if (!anchorBar || t - Date.parse(anchorBar.time) > 10_000) throw new Error(`Missing pre-release bid/ask history: ${event.releaseTimeUtc}`);
  const anchor = { at: Date.parse(anchorBar.time), bid: anchorBar.bid.open, ask: anchorBar.ask.open };
  for (const sequence of [["open", "high", "low", "close"], ["open", "low", "high", "close"]] as const) {
    const quotes: ReplayQuote[] = bars.filter(b => b.complete && Date.parse(b.time) >= t).flatMap(b => sequence.map((key, i) => ({ at: Date.parse(b.time) + i * 4999 / 3, bid: b.bid[key], ask: b.ask[key] })));
    // Bid/ask extremes need not occur together. Never fix a crossed synthetic
    // quote by silently changing its spread: exclude that path as unavailable.
    if (quotes.some(q => q.ask < q.bid)) { console.log(`Excluded crossed OHLC path ${event.releaseTimeUtc}`); continue; }
    results.push({ time: event.releaseTimeUtc, title: event.eventName, path: sequence.join("-"), dataPoints: quotes.length, result: replayNewsExits(anchor, t, quotes, assumptions) });
  }
}
const paths = [...new Set(results.map(r => r.path))].map(p => { const rows = results.filter(r => r.path === p), filled = rows.filter(r => r.result.entry && Number.isFinite(r.result.fixed?.r) && Number.isFinite(r.result.trailing?.r)); return { path: p, events: rows.length, filled: filled.length, skipped: rows.length - filled.length, fixedNetR: filled.length ? filled.reduce((s, r) => s + r.result.fixed!.r, 0) : null, trailingNetR: filled.length ? filled.reduce((s, r) => s + r.result.trailing!.r, 0) : null }; });
const limitations = ["Read-only OANDA S5 historical bid/ask OHLC, not tick replay or a live execution test.", "T−2 timing/acceptance cannot be verified with S5 candles. Entries use the last pre-release S5 open; evaluation begins at release. Pre-release fills are unobservable.", "Two synchronized OHLC paths are sensitivity scenarios, not actual market paths or statistical confidence bounds. Real bid/ask extremes may occur at different times.", "0.5 pip adverse entry and stop/horizon slippage; 2 pip entry bound; 3 pip spread gate; 250ms activation and OCO latency. S5 data cannot measure actual latency or double-fill frequency.", "Matched entries for fixed +2R and +10/7 trailing; fixed 15-pip original stop for this exit comparison, not an optimized ATR configuration.", "30-minute horizon forces both remaining positions out for comparability; live max-hold defaults disabled. No commission/financing estimate; inspect account-specific costs before interpreting net returns.", "Small historical sample, subject to timestamp/archive and intrabar uncertainty; cannot establish profitability or execution safety."];
await writeFile(path.join(output, "comparison.json"), JSON.stringify({ generatedAt: new Date().toISOString(), eventSource: raw.source, eventFile, assumptions, paths, limitations, results }, null, 2));
await writeFile(path.join(output, "REPORT.md"), `# News Straddle exit sensitivity replay\n\n${paths.map(p => `- ${p.path}: ${p.events} releases, ${p.filled} matched fills, ${p.skipped} skipped/excluded; ${p.fixedNetR === null || p.trailingNetR === null ? "no eligible fills, exit performance is not measurable" : `fixed 2R ${p.fixedNetR.toFixed(2)}R; trailing ${p.trailingNetR.toFixed(2)}R`}.`).join("\n")}\n\n${limitations.map(l => `- ${l}`).join("\n")}\n\nRecommendation: use tick recording and supervised practice fills before selecting an exit from these figures.\n`);
console.log(JSON.stringify({ output, paths, historicalReadOnly: true }));
