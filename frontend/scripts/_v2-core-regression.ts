/** Regression: prove pre-news-v2-core reproduces the frozen day-1 CSV exactly. */
import fs from "node:fs"; import path from "node:path";
const ENV = path.resolve(__dirname, "../../api-server/.env");
for (const l of fs.readFileSync(ENV, "utf8").split(/\r?\n/)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()); if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, ""); }
import * as core from "./pre-news-v2-core";
type RC = core.RC;

// --- day-1 event config (copied from pre-news-forex-test-v2.ts) ---
const U = (h: string) => `2026-09-17T${h}:00.000Z`;
const MAJORS = ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"];
const CCY_TO_PAIR: Record<string, string> = { EUR: "EUR_USD", GBP: "GBP_USD", JPY: "USD_JPY", CAD: "USD_CAD", AUD: "AUD_USD", NZD: "NZD_USD", CHF: "USD_CHF" };
type Rel = { ccy: string; impact: "HIGH" | "MEDIUM" | "LOW"; type: keyof typeof core.FROZEN.TYPE_VOL; forecast?: number; previous?: number; polarity?: 1 | -1; weight?: number };
type Ev = { id: string; utc: string; releases: Rel[] };
const EVENTS: Ev[] = [
  { id: "EUR_CPI", utc: U("09:00"), releases: [{ ccy: "EUR", impact: "MEDIUM", type: "INFLATION", forecast: 2.4, previous: 2.4, polarity: 1, weight: 0.8 }, { ccy: "EUR", impact: "MEDIUM", type: "INFLATION", forecast: 3.3, previous: 3.3, polarity: 1, weight: 0.8 }] },
  { id: "GBP_BOE", utc: U("11:00"), releases: [{ ccy: "GBP", impact: "HIGH", type: "CENTRAL_BANK", forecast: 3.75, previous: 3.75, polarity: 1, weight: 1.0 }, { ccy: "GBP", impact: "HIGH", type: "CENTRAL_BANK", forecast: 3, previous: 3, polarity: 1, weight: 0.6 }, { ccy: "GBP", impact: "HIGH", type: "CENTRAL_BANK" }] },
  { id: "USDCAD_830", utc: U("12:30"), releases: [{ ccy: "USD", impact: "HIGH", type: "MANUFACTURING", forecast: 31.3, previous: 47.4, polarity: 1, weight: 1.0 }, { ccy: "USD", impact: "HIGH", type: "EMPLOYMENT", forecast: 207, previous: 206, polarity: -1, weight: 0.8 }, { ccy: "USD", impact: "MEDIUM", type: "HOUSING", forecast: 1.40, previous: 1.43, polarity: 1, weight: 0.5 }, { ccy: "USD", impact: "MEDIUM", type: "HOUSING", forecast: 1.32, previous: 1.31, polarity: 1, weight: 0.5 }, { ccy: "CAD", impact: "MEDIUM", type: "INFLATION" }, { ccy: "CAD", impact: "MEDIUM", type: "INFLATION" }, { ccy: "CAD", impact: "MEDIUM", type: "HOUSING" }, { ccy: "CAD", impact: "LOW", type: "TRADE" }] },
  { id: "USD_PHS", utc: U("14:00"), releases: [{ ccy: "USD", impact: "MEDIUM", type: "HOUSING", forecast: -0.2, previous: -2.6, polarity: 1, weight: 0.4 }] },
  { id: "AUD_CBLI", utc: U("14:30"), releases: [{ ccy: "AUD", impact: "LOW", type: "OTHER" }] },
  { id: "NZD_FPI_TB", utc: U("22:45"), releases: [{ ccy: "NZD", impact: "MEDIUM", type: "INFLATION" }, { ccy: "NZD", impact: "MEDIUM", type: "TRADE" }] },
  { id: "JPY_BOJ", utc: U("23:30"), releases: [{ ccy: "JPY", impact: "HIGH", type: "CENTRAL_BANK", forecast: 1.25, previous: 1.00, polarity: 1, weight: 1.0 }, { ccy: "JPY", impact: "HIGH", type: "CENTRAL_BANK" }, { ccy: "JPY", impact: "HIGH", type: "INFLATION", forecast: 1.8, previous: 1.8, polarity: 1, weight: 0.7 }] },
];
const relsForPair = (ev: Ev, pair: string) => { const b = pair.slice(0, 3), q = pair.slice(4, 7); return ev.releases.filter((r) => r.ccy === b || r.ccy === q); };
function pairsForEvent(ev: Ev) { const cc = new Set(ev.releases.map((r) => r.ccy)); const s = new Set<string>(); for (const c of cc) { if (c === "USD") MAJORS.forEach((m) => s.add(m)); else if (CCY_TO_PAIR[c]) s.add(CCY_TO_PAIR[c]); } return [...s]; }

async function main() {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const insts = Array.from(new Set([...MAJORS, ...Object.values(core.STRENGTH_CROSSES).flat()]));
  const data = new Map<string, RC[]>();
  for (const inst of insts) { const b = await getResearchCandles(inst, "M1", 2880, { to: "2026-09-18T02:00:00.000Z" }); data.set(inst, b.filter((c) => c.complete).sort((a, z) => core.ms(a.time) - core.ms(z.time))); }

  // load day-1 CSV
  const csv = fs.readFileSync(path.resolve(__dirname, "../research-output/pre-news-forex-test-v2.csv"), "utf8").trim().split(/\r?\n/);
  const cols = csv[0]!.split(","); const idx = (c: string) => cols.indexOf(c);
  const csvRows = csv.slice(1).map((l) => l.split(","));
  const find = (event: string, pair: string) => csvRows.find((r) => r[idx("event")] === event && r[idx("pair")] === pair);

  let ok = 0, bad = 0;
  for (const ev of EVENTS) for (const pair of pairsForEvent(ev)) {
    const rels = relsForPair(ev, pair);
    const importance = rels.reduce((m, r) => Math.max(m, core.FROZEN.IMPORTANCE[r.impact]!), 0);
    const typeVol = rels.reduce((m, r) => Math.max(m, core.FROZEN.TYPE_VOL[r.type]!), 0);
    const base = pair.slice(0, 3), quote = pair.slice(4, 7);
    const fB = core.fundamentalScoreFromReleases(rels.filter((r) => r.ccy === base));
    const fQ = core.fundamentalScoreFromReleases(rels.filter((r) => r.ccy === quote));
    const row = await core.computeRow({ pair, cs: data.get(pair)!, data, T: core.ms(ev.utc), importance, typeVol, simultaneous: rels.length, fBase: fB, fQuote: fQ });
    const csvR = find(ev.id, pair)!;
    const csvMove = Number(csvR[idx("moveScore")]), csvDir = csvR[idx("direction")], csvDS = Number(csvR[idx("directionScore")]);
    const match = row.moveScore === csvMove && row.direction === csvDir && row.directionScore === csvDS;
    if (match) ok++; else { bad++; console.log(`MISMATCH ${ev.id} ${pair}: core(move=${row.moveScore},dir=${row.direction},ds=${row.directionScore}) vs csv(move=${csvMove},dir=${csvDir},ds=${csvDS})`); }
  }
  console.log(`\nregression: ${ok} match, ${bad} mismatch ${bad === 0 ? "-> CORE IS FAITHFUL ✔" : "-> DIVERGENCE �’"}`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
