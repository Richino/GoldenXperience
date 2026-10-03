// PHASE 15 — run TREND_PULLBACK_V2_FROZEN, unchanged, on 2024-01-01 → latest data.
// Reads the frozen config from FROZEN.json and refuses to run if its SHA-256 no
// longer matches the hash recorded at freeze time (FROZEN.sha256).
// DATA_DIR must hold the full 2007 → latest series (dev + post-2023 fetch merged),
// so indicators are warmed up on history exactly as they were in development.
import crypto from "node:crypto";
import fs from "node:fs";
import { loadData, simulate, type Config } from "./engine.mts";
import { byYear, summarize } from "./lib.mts";

const DATA = process.env.DATA_DIR!;
const OUT = process.env.OUT_DIR!;
const raw = fs.readFileSync(`${OUT}/FROZEN.json`, "utf8");
const hash = crypto.createHash("sha256").update(raw).digest("hex");
const expected = fs.readFileSync(`${OUT}/FROZEN.sha256`, "utf8").trim();
if (hash !== expected) throw new Error(`FROZEN.json changed after freezing (${hash} != ${expected})`);
const frozen = JSON.parse(raw) as { name: string; config: Config };
console.log(`STRATEGY FROZEN — BEGINNING TRUE OUT-OF-SAMPLE TEST\n${frozen.name} sha256 ${hash}`);

const FROM = Date.parse("2024-01-01T00:00:00Z");
const probe = loadData(DATA, FROM, Date.now(), `${DATA}/calendar_high.json`);
const lastBar = probe.m5.a[(probe.m5.n - 1) * 9]!;
const END = lastBar + 300_000;
const d = loadData(DATA, FROM, END, `${DATA}/calendar_high.json`);
const trades = simulate(d, frozen.config, FROM, END);
const years = (END - FROM) / (365.25 * 86_400_000);
const s = summarize(trades, years);
const gross = summarize(simulate(d, { ...frozen.config, mid: true }, FROM, END), years);
const mirror = summarize(simulate(d, { ...frozen.config, mirror: true }, FROM, END), years);
const report = {
  name: frozen.name, sha256: hash, period: [new Date(FROM).toISOString(), new Date(END).toISOString()],
  summary: s, byYear: byYear(trades, 2024, new Date(END).getUTCFullYear()), grossMid: gross, mirror,
  newsCalendarCoverage: { events: d.news.length, first: d.news.length ? new Date(d.news[0]!).toISOString() : null, last: d.news.length ? new Date(d.news[d.news.length - 1]!).toISOString() : null },
};
fs.writeFileSync(`${OUT}/OOS_2024_2026.json`, JSON.stringify(report, null, 1));
fs.writeFileSync(`${OUT}/OOS_2024_2026_trades.json`, JSON.stringify(trades));
console.log(JSON.stringify(s, null, 1));
console.table(report.byYear);
console.table({ net: s, grossMid: gross, mirror });
