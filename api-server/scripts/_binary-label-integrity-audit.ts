/** Read-only integrity audit for the recorded binary-baseline target. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { query } from "../src/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const OUT = path.join(root, "research-v2", "binary-label-integrity-v1"), REPORT = path.join(OUT, "FINAL_REPORT.txt");
type Result = "won" | "lost" | "tie";
type Mark = { priceTime?: string; result?: Result };
type Row = { instrument: string; start_at: string | Date; intended_expiration: string | Date; duration_seconds: number; resolution_price_time: string | Date | null; resolution_source: string | null; resolved_at: string | Date | null; result: Result; tie_tolerance: string; secondary_marks: Record<string, Mark> | null };

function ms(value: string | Date | null) { return value === null ? null : new Date(value).getTime(); }
function quantile(values: number[], q: number) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.round((sorted.length - 1) * q)]!; }
function seconds(value: number | null) { return value === null ? "n/a" : `${value.toFixed(1)}s`; }
function summary(values: number[]) { return `n=${values.length} min=${seconds(quantile(values, 0))} p50=${seconds(quantile(values, .5))} p95=${seconds(quantile(values, .95))} max=${seconds(quantile(values, 1))}`; }
function score(results: Result[]) { const wins = results.filter((value) => value === "won").length, losses = results.filter((value) => value === "lost").length, ties = results.length - wins - losses, decided = wins + losses; return `${wins}W/${losses}L/${ties}T; WR=${decided ? `${(wins / decided * 100).toFixed(2)}%` : "n/a"}; coverage=${results.length}`; }

fs.mkdirSync(OUT, { recursive: true });
const rows = (await query<Row>(`SELECT instrument,start_at,intended_expiration,duration_seconds,resolution_price_time,resolution_source,resolved_at,result,tie_tolerance,secondary_marks
  FROM binary_predictions WHERE model_name='binary-baseline-v1' AND is_authoritative=true AND status='resolved' AND result IN ('won','lost','tie') ORDER BY start_at`)).rows;
if (!rows.length) throw new Error("No resolved authoritative binary-baseline rows.");
const intendedDelta: number[] = [], markDelay: number[] = [], processingDelay: number[] = [], official: Result[] = [], five: Result[] = [], fifteen: Result[] = [];
const source = new Map<string, number>(), durations = new Map<number, number>(), tolerances = new Map<string, number>(), starts = new Map<string, number>();
for (const row of rows) {
  const start = ms(row.start_at)!, intended = ms(row.intended_expiration)!, mark = ms(row.resolution_price_time), resolved = ms(row.resolved_at);
  intendedDelta.push((intended - start) / 1000); if (mark !== null) markDelay.push((mark - intended) / 1000); if (mark !== null && resolved !== null) processingDelay.push((resolved - mark) / 1000);
  official.push(row.result); source.set(row.resolution_source ?? "missing", (source.get(row.resolution_source ?? "missing") ?? 0) + 1); durations.set(row.duration_seconds, (durations.get(row.duration_seconds) ?? 0) + 1); tolerances.set(row.tie_tolerance, (tolerances.get(row.tie_tolerance) ?? 0) + 1); starts.set(`${row.instrument}/${new Date(row.start_at).toISOString()}`, (starts.get(`${row.instrument}/${new Date(row.start_at).toISOString()}`) ?? 0) + 1);
  const marks = row.secondary_marks ?? {}; if (marks["300s"]?.result) five.push(marks["300s"].result!); if (marks["900s"]?.result) fifteen.push(marks["900s"].result!);
}
const duplicateStarts = [...starts.values()].filter((count) => count > 1), markBeforeExpiry = markDelay.filter((delay) => delay < 0).length, lateOver120 = markDelay.filter((delay) => delay > 120).length;
const lines = [
  "GOLDENXPERIENCE — BINARY LABEL / SETTLEMENT INTEGRITY AUDIT", "Read-only audit of the settled authoritative binary-baseline rows. No runtime behavior or records changed.", "",
  `Rows: ${rows.length}; window: ${new Date(rows[0]!.start_at).toISOString()} → ${new Date(rows.at(-1)!.start_at).toISOString()}.`,
  `Official duration distribution: ${[...durations.entries()].sort((a, b) => a[0] - b[0]).map(([duration, count]) => `${duration}s=${count}`).join(", ")}.`,
  `Intended expiration minus start: ${summary(intendedDelta)}.`,
  `Official outcome at the stored duration: ${score(official)}.`,
  `Resolution source: ${[...source.entries()].map(([name, count]) => `${name}=${count}`).join(", ")}.`,
  `Actual mark time minus intended expiration: ${summary(markDelay)}; before-expiry=${markBeforeExpiry}; later than 120s=${lateOver120}.`,
  `Database resolve time minus actual mark time: ${summary(processingDelay)}.`,
  `Tie tolerance distribution: ${[...tolerances.entries()].map(([value, count]) => `${value}=${count}`).join(", ")}.`,
  `Secondary 5m marks: ${score(five)}; missing=${rows.length - five.length}.`,
  `Secondary 15m marks: ${score(fifteen)}; missing=${rows.length - fifteen.length}.`,
  `Duplicate (instrument,start_at) identities: ${duplicateStarts.length}; maximum duplicate count=${Math.max(...starts.values())}.`, "",
  "Interpretation rules:",
  "- A non-zero mark delay is not automatically bad: settlement deliberately stores its actual verified market timestamp rather than pretending it was exact expiry.",
  "- A large or inconsistent delay, missing secondary marks, or an outcome shift by horizon would mean the target needs repair before more signal mining.",
  "- Identical start times across different instruments are expected; duplicates within the same instrument would be a data-quality defect.",
];
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`); console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
